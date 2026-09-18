package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// AI 對話：以 OpenAI 相容的 /chat/completions 串流回覆，逐段以事件送到前端。
//   ai:delta  { id, text }
//   ai:done   { id }
//   ai:error  { id, message }

type AIMessage struct {
	Role    string `json:"role"` // system / user / assistant
	Content string `json:"content"`
}

var (
	chatMu      sync.Mutex
	chatCancels = map[string]context.CancelFunc{}
)

// StartAIChat 開始一次串流對話；id 由前端指定，用來取消與對應事件。
func (a *App) StartAIChat(id string, messages []AIMessage) error {
	ar, err := resolveRequest(AISaveRequest{Key: keepSecret})
	if err != nil {
		return err
	}
	if ar.model == "" {
		return fmt.Errorf("AI_NO_MODEL")
	}
	payload, err := json.Marshal(map[string]any{
		"model":    ar.model,
		"messages": messages,
		"stream":   true,
	})
	if err != nil {
		return err
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
		if err := a.streamChat(ctx, ar, payload, id); err != nil {
			if ctx.Err() != nil {
				runtime.EventsEmit(a.ctx, "ai:done", id) // 使用者按停止
				return
			}
			runtime.EventsEmit(a.ctx, "ai:error", id, err.Error())
			return
		}
		runtime.EventsEmit(a.ctx, "ai:done", id)
	}()
	return nil
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

func (a *App) streamChat(ctx context.Context, ar *aiRequest, payload []byte, id string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ar.url("/chat/completions"), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	ar.apply(req)
	req.Header.Set("Accept", "text/event-stream")
	res, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("AI_NETWORK|%v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		return aiError(res.StatusCode, body)
	}

	reader := bufio.NewReaderSize(res.Body, 64*1024)
	var pending strings.Builder // 累積一小段再送，避免事件過於頻繁
	lastFlush := time.Now()
	flush := func() {
		if pending.Len() > 0 {
			runtime.EventsEmit(a.ctx, "ai:delta", id, pending.String())
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
					return nil
				}
				var chunk struct {
					Choices []struct {
						Delta struct {
							Content string `json:"content"`
						} `json:"delta"`
						Message struct {
							Content string `json:"content"`
						} `json:"message"`
					} `json:"choices"`
					Error struct {
						Message string `json:"message"`
					} `json:"error"`
				}
				if json.Unmarshal([]byte(data), &chunk) == nil {
					if chunk.Error.Message != "" {
						flush()
						return fmt.Errorf("AI_SERVICE|%s", chunk.Error.Message)
					}
					for _, c := range chunk.Choices {
						text := c.Delta.Content
						if text == "" {
							text = c.Message.Content
						}
						if text != "" {
							pending.WriteString(text)
						}
					}
					// 累積夠多、或距上次送出已超過 120 毫秒就送，讓逐字顯示保持順暢
					if pending.Len() > 160 || (pending.Len() > 0 && time.Since(lastFlush) > 120*time.Millisecond) {
						flush()
					}
				}
			}
		}
		if err != nil {
			flush()
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}
