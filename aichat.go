package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// AI 對話：以 OpenAI 相容的 /chat/completions 串流回覆，逐段以事件送到前端。
//   ai:delta  { id, text }
//   ai:done   { id }
//   ai:error  { id, message }
//   ai:tool   { id, name, detail }  模型呼叫工具（detail 是路徑或搜尋文字）

type AIMessage struct {
	Role             string `json:"role"` // system / user / assistant
	Content          string `json:"content"`
	ReasoningContent string `json:"reasoning_content,omitempty"` // 先前回覆的思考內容，只有 DeepSeek 開工具時才送出
}

// emitEvent 把事件送到前端；測試時換掉，就不需要 Wails 的執行環境。
var emitEvent = runtime.EventsEmit

// toolCall 是模型要求的一次工具呼叫（串流分片拼好之後）。
type toolCall struct {
	ID   string
	Name string
	Args string
}

// toolCallDelta 是串流裡 tool_calls 的一段。
type toolCallDelta struct {
	Index    *int   `json:"index"`
	ID       string `json:"id"`
	Function struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
}

// 一輪最多接受幾個工具呼叫，避免異常的 index 讓切片無限長大
const maxCallsPerRound = 16

// toolCallAccumulator 把分段送來的工具呼叫拼回來。名稱與參數通常拆成好幾段，只有第一段帶 id；
// 有些服務不帶 index（改用 id 區分），有些每段都重送完整名稱，參數也可能直接給物件。
type toolCallAccumulator struct {
	calls []*toolCall
}

// add 收一段；position 是這段在該 chunk 的 tool_calls 陣列中的位置。
func (acc *toolCallAccumulator) add(position int, d toolCallDelta) {
	var c *toolCall
	if d.Index != nil {
		if *d.Index < 0 || *d.Index >= maxCallsPerRound {
			return
		}
		for len(acc.calls) <= *d.Index {
			acc.calls = append(acc.calls, &toolCall{})
		}
		c = acc.calls[*d.Index]
	} else {
		last := len(acc.calls) - 1
		if last < 0 || position > 0 || (d.ID != "" && acc.calls[last].ID != "" && acc.calls[last].ID != d.ID) {
			if len(acc.calls) >= maxCallsPerRound {
				return
			}
			acc.calls = append(acc.calls, &toolCall{})
			last = len(acc.calls) - 1
		}
		c = acc.calls[last]
	}
	if d.ID != "" && c.ID == "" {
		c.ID = d.ID
	}
	if name := d.Function.Name; name != "" && name != c.Name {
		c.Name += name // 每段都重送完整名稱時，相同的就不再接上
	}
	c.Args += argumentText(d.Function.Arguments)
}

// result 回傳拼好的呼叫：沒有名稱的無法執行，直接丟掉；沒有參數的補成 {}。
func (acc *toolCallAccumulator) result() []toolCall {
	var out []toolCall
	for _, c := range acc.calls {
		if c.Name == "" {
			continue
		}
		call := *c
		if strings.TrimSpace(call.Args) == "" {
			call.Args = "{}"
		}
		out = append(out, call)
	}
	return out
}

// argumentText：arguments 照規格是 JSON 字串，少數服務直接給物件。
func argumentText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}

// streamResult 是一輪串流的結果：文字已經邊收邊送到前端，這裡再留一份給工具迴圈組下一輪的訊息。
type streamResult struct {
	content   string
	reasoning string // 這一輪的思考內容（DeepSeek 回填時要附上）
	calls     []toolCall
	usage     []int // prompt / completion / total tokens；服務沒回報時為 nil
}

// httpStatusError 保留服務的原始回應，讓呼叫端決定怎麼解讀（例如第一輪帶了 tools 時辨識「不支援工具呼叫」）。
type httpStatusError struct {
	status int
	body   []byte
}

func (e *httpStatusError) Error() string { return aiError(e.status, e.body).Error() }

// 工具往返時追加的訊息：只存在這一次請求裡，不回傳前端、不寫進對話紀錄。
type toolCallsMessage struct {
	Role             string         `json:"role"`    // assistant
	Content          *string        `json:"content"` // 沒有文字時送 null
	ReasoningContent string         `json:"reasoning_content,omitempty"`
	ToolCalls        []toolCallJSON `json:"tool_calls"`
}

type toolCallJSON struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"`
	Function toolCallFunction `json:"function"`
}

type toolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type toolResultMessage struct {
	Role       string `json:"role"` // tool
	ToolCallID string `json:"tool_call_id"`
	Content    string `json:"content"`
}

// 一次提問最多執行幾輪工具；超過就停下來，避免模型無限呼叫
const maxToolRounds = 8

var (
	chatMu      sync.Mutex
	chatCancels = map[string]context.CancelFunc{}
)

// StartAIChat 開始一次串流對話；id 由前端指定，用來取消與對應事件。
// root 是側邊欄開啟的資料夾：設定允許使用工具、而且真的有開資料夾時，模型才能呼叫內建工具。
func (a *App) StartAIChat(id string, messages []AIMessage, root string) error {
	ar, err := resolveRequest(AISaveRequest{Key: keepSecret, Thinking: keepSecret})
	if err != nil {
		return err
	}
	if ar.model == "" {
		return fmt.Errorf("AI_NO_MODEL")
	}
	if info, err := os.Stat(root); !ar.tools || root == "" || err != nil || !info.IsDir() {
		root = "" // 不帶 tools，請求與以前完全相同
	}
	ctx, cancel := context.WithCancel(context.Background())
	chatMu.Lock()
	if old := chatCancels[id]; old != nil {
		old()
	}
	chatCancels[id] = cancel
	chatMu.Unlock()

	go func() {
		defer func() {
			chatMu.Lock()
			delete(chatCancels, id)
			chatMu.Unlock()
			cancel()
		}()
		if err := a.runChat(ctx, ar, messages, root, id); err != nil {
			if ctx.Err() != nil {
				emitEvent(a.ctx, "ai:done", id) // 使用者按停止
				return
			}
			emitEvent(a.ctx, "ai:error", id, err.Error())
			return
		}
		emitEvent(a.ctx, "ai:done", id)
	}()
	return nil
}

// runChat 送出對話。模型要求呼叫工具時，執行工具、把結果以 role "tool" 回填，再送下一輪，
// 直到模型給出一般回覆。root 為空字串時不帶 tools，只送一輪。
func (a *App) runChat(ctx context.Context, ar *aiRequest, messages []AIMessage, root, id string) error {
	// DeepSeek 在請求帶 tools 時，必須把先前每則 assistant 訊息的 reasoning_content 送回（否則回 400），其他情況一律不送
	keepReasoning := root != "" && ar.provider == "deepseek"
	history := make([]any, 0, len(messages)+4)
	for _, m := range messages {
		if !keepReasoning {
			m.ReasoningContent = ""
		}
		history = append(history, m)
	}
	for round := 0; ; round++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		body := map[string]any{"model": ar.model, "messages": history, "stream": true}
		if root != "" {
			body["tools"] = builtinTools
		}
		applyThinking(body, ar)
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		res, err := a.streamChat(ctx, ar, payload, id)
		var status *httpStatusError
		if round == 0 && root != "" && errors.As(err, &status) {
			return aiToolsError(status.status, status.body)
		}
		if err != nil {
			return err
		}
		if round == 0 && res.usage != nil {
			// 只回報第一輪：之後幾輪含工具結果，拿來校正長度估算會失準
			emitEvent(a.ctx, "ai:usage", id, res.usage[0], res.usage[1], res.usage[2])
		}
		if root == "" || len(res.calls) == 0 {
			return nil
		}
		if round == maxToolRounds {
			return fmt.Errorf("AI_TOOL_LIMIT|%d", maxToolRounds)
		}
		call := toolCallsMessage{Role: "assistant"}
		if res.content != "" {
			call.Content = &res.content
		}
		if keepReasoning {
			call.ReasoningContent = res.reasoning
		}
		results := make([]any, 0, len(res.calls))
		for i, c := range res.calls {
			if c.ID == "" {
				c.ID = fmt.Sprintf("call_%d_%d", round+1, i+1)
			}
			call.ToolCalls = append(call.ToolCalls, toolCallJSON{ID: c.ID, Type: "function", Function: toolCallFunction{Name: c.Name, Arguments: c.Args}})
			emitEvent(a.ctx, "ai:tool", id, c.Name, toolDetail(c.Name, c.Args))
			out, err := a.runToolContext(ctx, root, c)
			if err != nil {
				return err
			}
			results = append(results, toolResultMessage{Role: "tool", ToolCallID: c.ID, Content: out})
		}
		history = append(append(history, call), results...)
		if res.content != "" {
			emitEvent(a.ctx, "ai:delta", id, "\n\n") // 下一輪的回覆接在後面，中間空一行
		}
	}
}

// runToolContext 在背景執行工具；使用者按停止時立刻返回，不等工具跑完（工具都是唯讀的，讓它自己結束即可）。
func (a *App) runToolContext(ctx context.Context, root string, c toolCall) (string, error) {
	out := make(chan string, 1)
	go func() { out <- a.runTool(root, c.Name, c.Args) }()
	select {
	case s := <-out:
		return s, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// applyThinking 依供應商把思考模式寫進請求；未設定時什麼都不加，
// 避免不支援這些參數的服務（例如公司自架的舊版閘道）直接回 400。
//
//	OpenAI / Gemini / 自訂：reasoning_effort = none / low / medium / high / xhigh / max
//	DeepSeek：thinking.type = disabled / enabled，再以 reasoning_effort 指定 low / high / max
func applyThinking(body map[string]any, ar *aiRequest) {
	if ar.thinking == "" {
		return
	}
	if ar.provider == "deepseek" {
		if ar.thinking == "off" {
			body["thinking"] = map[string]any{"type": "disabled"}
			return
		}
		body["thinking"] = map[string]any{"type": "enabled"}
		switch ar.thinking {
		case "low":
			body["reasoning_effort"] = "low"
		case "high":
			body["reasoning_effort"] = "high"
		case "xhigh", "max":
			body["reasoning_effort"] = "max" // DeepSeek 最高只到 max
		}
		return
	}
	if ar.thinking == "off" {
		body["reasoning_effort"] = "none"
		return
	}
	body["reasoning_effort"] = ar.thinking
}

// CancelAIChat 停止產生。
func (a *App) CancelAIChat(id string) {
	chatMu.Lock()
	cancel := chatCancels[id]
	chatMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (a *App) streamChat(ctx context.Context, ar *aiRequest, payload []byte, id string) (*streamResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ar.url("/chat/completions"), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	ar.apply(req)
	req.Header.Set("Accept", "text/event-stream")
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("AI_NETWORK|%v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		return nil, &httpStatusError{status: res.StatusCode, body: body}
	}

	reader := bufio.NewReaderSize(res.Body, 64*1024)
	var pending strings.Builder   // 累積一小段再送，避免事件過於頻繁
	var thinking strings.Builder  // 思考內容（reasoning_content）另外送，前端可收合
	var full strings.Builder      // 這一輪完整的回覆文字（工具迴圈組下一輪訊息用）
	var reasoning strings.Builder // 這一輪完整的思考內容
	var calls toolCallAccumulator
	var usage []int
	done := func() *streamResult {
		return &streamResult{content: full.String(), reasoning: reasoning.String(), calls: calls.result(), usage: usage}
	}
	lastFlush := time.Now()
	flush := func() {
		if thinking.Len() > 0 {
			emitEvent(a.ctx, "ai:think", id, thinking.String())
			thinking.Reset()
			lastFlush = time.Now()
		}
		if pending.Len() > 0 {
			emitEvent(a.ctx, "ai:delta", id, pending.String())
			pending.Reset()
			lastFlush = time.Now()
		}
	}
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			line = strings.TrimRight(line, "\r\n")
			if data, ok := strings.CutPrefix(line, "data:"); ok {
				data = strings.TrimSpace(data)
				if data == "[DONE]" {
					flush()
					return done(), nil
				}
				var chunk struct {
					Choices []struct {
						Delta struct {
							Content          string          `json:"content"`
							ReasoningContent string          `json:"reasoning_content"` // DeepSeek
							Reasoning        string          `json:"reasoning"`         // 部分閘道（LiteLLM、OpenRouter 等）
							ToolCalls        json.RawMessage `json:"tool_calls"`        // 另外解析，格式怪異時不影響文字
						} `json:"delta"`
						Message struct {
							Content          string          `json:"content"`
							ReasoningContent string          `json:"reasoning_content"`
							Reasoning        string          `json:"reasoning"`
							ToolCalls        json.RawMessage `json:"tool_calls"`
						} `json:"message"`
					} `json:"choices"`
					Error struct {
						Message string `json:"message"`
					} `json:"error"`
					Usage *struct {
						PromptTokens     int `json:"prompt_tokens"`
						CompletionTokens int `json:"completion_tokens"`
						TotalTokens      int `json:"total_tokens"`
					} `json:"usage"`
				}
				if json.Unmarshal([]byte(data), &chunk) == nil {
					if chunk.Error.Message != "" {
						flush()
						return nil, fmt.Errorf("AI_SERVICE|%s", chunk.Error.Message)
					}
					// 服務多半把 usage 放在最後一個 chunk；由 runChat 決定要不要送給前端
					if u := chunk.Usage; u != nil && u.TotalTokens > 0 {
						usage = []int{u.PromptTokens, u.CompletionTokens, u.TotalTokens}
					}
					for _, c := range chunk.Choices {
						text := c.Delta.Content
						if text == "" {
							text = c.Message.Content
						}
						if text != "" {
							pending.WriteString(text)
							full.WriteString(text)
						}
						raw := c.Delta.ToolCalls
						if len(raw) == 0 && len(calls.calls) == 0 {
							raw = c.Message.ToolCalls // 只給完整 message 的服務；已經收過分片就不再重複接上
						}
						var deltas []toolCallDelta
						if len(raw) > 0 && json.Unmarshal(raw, &deltas) == nil {
							for j, d := range deltas {
								calls.add(j, d)
							}
						}
						think := c.Delta.ReasoningContent
						if think == "" {
							think = c.Delta.Reasoning
						}
						if think == "" {
							think = c.Message.ReasoningContent
						}
						if think == "" {
							think = c.Message.Reasoning
						}
						if think != "" {
							thinking.WriteString(think)
							reasoning.WriteString(think)
						}
					}
					// 累積夠多、或距上次送出已超過 120 毫秒就送，讓逐字顯示保持順暢
					buffered := pending.Len() + thinking.Len()
					if buffered > 160 || (buffered > 0 && time.Since(lastFlush) > 120*time.Millisecond) {
						flush()
					}
				}
			}
		}
		if err != nil {
			flush()
			if err == io.EOF {
				return done(), nil
			}
			return nil, err
		}
	}
}
