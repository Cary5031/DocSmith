package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// ---- 內建工具：資料夾邊界與輸出 ----

// newToolFolder 建一個開啟中的資料夾 work，旁邊放一個不該被讀到的 outside。
func newToolFolder(t *testing.T) (root, outside string) {
	t.Helper()
	base := t.TempDir()
	root = filepath.Join(base, "work")
	outside = filepath.Join(base, "outside")
	files := map[string]string{
		filepath.Join(root, "README.md"):         "hello MCP world\nsecond line\n",
		filepath.Join(root, "docs", "guide.md"):  "MCP guide\n",
		filepath.Join(root, "big.txt"):           strings.Repeat("字", 25000),
		filepath.Join(root, "bin.dat"):           "\x01\x00\x02\x00",
		filepath.Join(outside, "secret.txt"):     "TOP SECRET MCP\n",
		filepath.Join(outside, "sub", "more.md"): "TOP SECRET too\n",
	}
	for path, content := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root, outside
}

func jsonArgs(key, value string) string {
	b, _ := json.Marshal(map[string]string{key: value})
	return string(b)
}

func wantIn(t *testing.T, label, got string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("%s：應該包含 %q，實際是：\n%s", label, w, got)
		}
	}
}

func wantNotIn(t *testing.T, label, got string, bad ...string) {
	t.Helper()
	for _, b := range bad {
		if strings.Contains(got, b) {
			t.Errorf("%s：不該出現 %q，實際是：\n%s", label, b, got)
		}
	}
}

func TestToolPathEscape(t *testing.T) {
	root, outside := newToolFolder(t)
	a := &App{}
	const outsideErr = "outside the open folder"
	cases := map[string]string{
		"..":        "../outside/secret.txt",
		"多層 ..":     "../../Windows/win.ini",
		"中間夾 ..":    "docs/../../outside/secret.txt",
		"其他磁碟":      `C:\Windows\win.ini`,
		"磁碟機相對路徑":   "C:secret.txt",
		"資料夾外的絕對路徑": filepath.Join(outside, "secret.txt"),
		"UNC":       `\\localhost\c$\Windows\win.ini`,
		"裝置名稱":      "CON",
		"NUL 加副檔名":  "NUL.txt",
		"alternate": "README.md:secret",
		"空白包住的 ..":  "  ../outside/secret.txt  ",
	}
	for label, p := range cases {
		got := a.runTool(root, "read_file", jsonArgs("path", p))
		wantIn(t, label, got, outsideErr)
		wantNotIn(t, label, got, "TOP SECRET")
	}
	wantIn(t, "列出上層", a.runTool(root, "list_dir", jsonArgs("path", "..")), outsideErr)

	// junction 指到資料夾外：mklink /J 不需要系統管理員權限
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", filepath.Join(root, "link"), outside).CombinedOutput(); err != nil {
		t.Logf("無法建立 junction，略過這部分：%v %s", err, out)
	} else {
		got := a.runTool(root, "read_file", jsonArgs("path", "link/secret.txt"))
		wantIn(t, "經 junction 讀檔", got, outsideErr)
		wantNotIn(t, "經 junction 讀檔", got, "TOP SECRET")
		wantIn(t, "經 junction 列目錄", a.runTool(root, "list_dir", jsonArgs("path", "link/sub")), outsideErr)
		wantNotIn(t, "搜尋不會走進 junction", a.runTool(root, "search_folder", jsonArgs("query", "SECRET")), "TOP SECRET", "secret.txt")
	}
	// symlink 需要開發人員模式或權限，建不起來就略過
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "slink.txt")); err != nil {
		t.Logf("無法建立 symlink，略過這部分：%v", err)
	} else {
		got := a.runTool(root, "read_file", jsonArgs("path", "slink.txt"))
		wantIn(t, "經 symlink 讀檔", got, outsideErr)
		wantNotIn(t, "經 symlink 讀檔", got, "TOP SECRET")
	}
}

func TestToolResults(t *testing.T) {
	root, _ := newToolFolder(t)
	a := &App{}
	run := func(name, args string) string { return a.runTool(root, name, args) }

	wantIn(t, "列出根目錄", run("list_dir", `{"path":"."}`), "Contents of . (4 items)", "docs/", "README.md  (28 B)")
	wantIn(t, "沒給路徑就是根目錄", run("list_dir", `{}`), "Contents of .", "README.md")
	wantIn(t, "列出子資料夾", run("list_dir", `{"path":"docs"}`), "Contents of docs", "guide.md")
	wantIn(t, "讀檔", run("read_file", `{"path":"README.md"}`), "File README.md (28 characters):\nhello MCP world")
	wantIn(t, "開頭的 / 視為根目錄", run("read_file", `{"path":"/README.md"}`), "hello MCP world")
	wantIn(t, "繞一圈還在資料夾內", run("read_file", `{"path":"docs/../README.md"}`), "hello MCP world")
	wantIn(t, "資料夾內的絕對路徑", run("read_file", jsonArgs("path", filepath.Join(root, "docs", "guide.md"))), "MCP guide")
	wantIn(t, "搜尋（不分大小寫）", run("search_folder", `{"query":"mcp"}`),
		"2 matching lines in 2 files", "README.md:1: hello MCP world", "docs/guide.md:1: MCP guide")
	wantIn(t, "搜尋不到", run("search_folder", `{"query":"zzz-not-here"}`), `No matches for "zzz-not-here".`)
	wantIn(t, "空的搜尋", run("search_folder", `{"query":"  "}`), "Error: the query is empty")
	wantIn(t, "過長截斷", run("read_file", `{"path":"big.txt"}`),
		"(25000 characters)", "[Truncated: showing the first 20000 of 25000 characters]")
	wantIn(t, "二進位檔", run("read_file", `{"path":"bin.dat"}`), "Error: bin.dat is not a text file")
	missing := run("read_file", `{"path":"nope.md"}`)
	wantIn(t, "找不到", missing, "Error: nope.md was not found")
	wantNotIn(t, "錯誤不帶出本機路徑", missing, root)
	wantIn(t, "讀資料夾", run("read_file", `{"path":"docs"}`), "docs is a folder")
	wantIn(t, "列檔案", run("list_dir", `{"path":"README.md"}`), "README.md is a file")
	wantIn(t, "不認得的工具", run("delete_all", `{}`), `Error: unknown tool "delete_all"`)
	wantIn(t, "參數不是 JSON", run("read_file", `{"path":`), "Error: invalid arguments")
	if got := a.runTool("", "list_dir", `{}`); got != "Error: no folder is open." {
		t.Errorf("沒開資料夾：%s", got)
	}
}

func TestToolDetail(t *testing.T) {
	cases := [][3]string{
		{"search_folder", `{"query":" MCP "}`, "MCP"},
		{"read_file", `{"path":"docs/a.md"}`, "docs/a.md"},
		{"list_dir", `{}`, "."},
		{"read_file", jsonArgs("path", strings.Repeat("長", 100)), strings.Repeat("長", 80) + "…"},
		{"unknown", `not json`, ""},
	}
	for _, c := range cases {
		if got := toolDetail(c[0], c[1]); got != c[2] {
			t.Errorf("toolDetail(%s, %s) = %q，應該是 %q", c[0], c[1], got, c[2])
		}
	}
}

// ---- 設定與錯誤代碼 ----

func TestToolsSetting(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	if !strings.HasPrefix(aiConfigPath(), os.Getenv("AppData")) {
		t.Fatalf("設定檔沒有導到測試資料夾：%s", aiConfigPath())
	}
	a := &App{}
	if err := a.SaveAIConfig(AISaveRequest{Provider: "custom", BaseURL: "http://x/v1", Model: "m", Key: "k", Tools: true}); err != nil {
		t.Fatal(err)
	}
	if !a.GetAIConfig().Providers["custom"].Tools {
		t.Error("存了開啟，讀回來卻是關閉")
	}
	if a.GetAIConfig().Providers["openai"].Tools {
		t.Error("其他供應商應該維持關閉")
	}
	if ar, err := resolveRequest(AISaveRequest{Provider: "custom", Key: keepSecret, Thinking: keepSecret}); err != nil || !ar.tools {
		t.Errorf("對話請求沒有沿用開關：%v", err)
	}
	if err := a.SaveAIConfig(AISaveRequest{Provider: "custom", BaseURL: "http://x/v1", Model: "m", Key: keepSecret}); err != nil {
		t.Fatal(err)
	}
	if a.GetAIConfig().Providers["custom"].Tools {
		t.Error("存檔時沒帶 tools 應該變回關閉")
	}
}

func TestAIToolsError(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   string
	}{
		{400, `{"error":{"message":"Unrecognized request argument supplied: tools"}}`, "AI_TOOLS_UNSUPPORTED|Unrecognized request argument supplied: tools"},
		{400, `{"error":{"message":"deepseek-reasoner does not support Function Calling"}}`, "AI_TOOLS_UNSUPPORTED|deepseek-reasoner does not support Function Calling"},
		{422, `{"error":{"message":"tool_choice is not supported"}}`, "AI_TOOLS_UNSUPPORTED|tool_choice is not supported"},
		// 超過對話長度的錯誤也會提到 functions，不能誤判
		{400, `{"error":{"message":"This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens (8800 in the messages, 200 in the functions)."}}`,
			"AI_HTTP_400|This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens (8800 in the messages, 200 in the functions)."},
		{400, `{"error":{"message":"Invalid API key for tools"}}`, "AI_UNAUTHORIZED|Invalid API key for tools"},
		{401, `{"error":{"message":"tools not allowed"}}`, "AI_UNAUTHORIZED|tools not allowed"},
		{500, `{"error":{"message":"failed to parse tool call"}}`, "AI_HTTP_500|failed to parse tool call"},
		{400, `{"error":{"message":"invalid model"}}`, "AI_HTTP_400|invalid model"},
	}
	for _, c := range cases {
		if got := aiToolsError(c.status, []byte(c.body)).Error(); got != c.want {
			t.Errorf("%d %s\n實際 %s\n應為 %s", c.status, c.body, got, c.want)
		}
	}
}

// ---- 串流裡的工具呼叫分片 ----

func accumulate(t *testing.T, chunks ...string) []toolCall {
	t.Helper()
	var acc toolCallAccumulator
	for _, c := range chunks {
		var ds []toolCallDelta
		if err := json.Unmarshal([]byte(c), &ds); err != nil {
			t.Fatal(err)
		}
		for j, d := range ds {
			acc.add(j, d)
		}
	}
	return acc.result()
}

func TestToolCallAccumulator(t *testing.T) {
	cases := []struct {
		name   string
		chunks []string
		want   []toolCall
	}{
		{"OpenAI 格式：第一段帶 id 與名稱，之後只有參數", []string{
			`[{"index":0,"id":"c1","type":"function","function":{"name":"list_dir","arguments":"{"}}]`,
			`[{"index":0,"function":{"arguments":"\"path\":\""}}]`,
			`[{"index":0,"function":{"arguments":".\"}"}}]`,
		}, []toolCall{{"c1", "list_dir", `{"path":"."}`}}},
		{"兩個呼叫交錯送", []string{
			`[{"index":0,"id":"a","function":{"name":"read_file","arguments":""}}]`,
			`[{"index":1,"id":"b","function":{"name":"search_folder","arguments":"{\"query\":"}}]`,
			`[{"index":0,"function":{"arguments":"{\"path\":\"x.md\"}"}}]`,
			`[{"index":1,"function":{"arguments":"\"MCP\"}"}}]`,
		}, []toolCall{{"a", "read_file", `{"path":"x.md"}`}, {"b", "search_folder", `{"query":"MCP"}`}}},
		{"沒有 index，靠 id 區分", []string{
			`[{"id":"g1","function":{"name":"list_dir","arguments":"{\"path\":\".\"}"}}]`,
			`[{"id":"g2","function":{"name":"read_file","arguments":"{\"path\":\"a.md\"}"}}]`,
		}, []toolCall{{"g1", "list_dir", `{"path":"."}`}, {"g2", "read_file", `{"path":"a.md"}`}}},
		{"沒有 index，同一段裡兩個呼叫", []string{
			`[{"function":{"name":"list_dir","arguments":"{}"}},{"function":{"name":"read_file","arguments":"{\"path\":\"b\"}"}}]`,
		}, []toolCall{{"", "list_dir", `{}`}, {"", "read_file", `{"path":"b"}`}}},
		{"每段都重送完整名稱", []string{
			`[{"index":0,"id":"r","function":{"name":"read_file","arguments":"{\"pa"}}]`,
			`[{"index":0,"id":"r","function":{"name":"read_file","arguments":"th\":\"a\"}"}}]`,
		}, []toolCall{{"r", "read_file", `{"path":"a"}`}}},
		{"名稱拆成兩段", []string{
			`[{"index":0,"id":"s","function":{"name":"search_","arguments":""}}]`,
			`[{"index":0,"function":{"name":"folder","arguments":"{\"query\":\"x\"}"}}]`,
		}, []toolCall{{"s", "search_folder", `{"query":"x"}`}}},
		{"參數直接給物件", []string{
			`[{"index":0,"id":"o","function":{"name":"read_file","arguments":{"path":"a.md"}}}]`,
		}, []toolCall{{"o", "read_file", `{"path":"a.md"}`}}},
		{"不合理的 index 忽略", []string{
			`[{"index":1000000,"id":"x","function":{"name":"list_dir","arguments":"{}"}}]`,
		}, nil},
		{"沒有名稱的丟掉，沒有參數的補 {}", []string{
			`[{"index":0,"id":"n","function":{"arguments":"{}"}}]`,
			`[{"index":1,"id":"e","function":{"name":"list_dir"}}]`,
		}, []toolCall{{"e", "list_dir", `{}`}}},
	}
	for _, c := range cases {
		if got := accumulate(t, c.chunks...); fmt.Sprint(got) != fmt.Sprint(c.want) {
			t.Errorf("%s\n實際 %v\n應為 %v", c.name, got, c.want)
		}
	}
}

// 公司閘道（llama.cpp）實際回的第一輪串流，只把模型名稱換掉、思考內容縮短：
// 思考走 reasoning_content，工具呼叫第一段帶 index / id / name，之後每段只帶 arguments，content 是 null。
const gatewayToolStream = `data: {"choices":[{"finish_reason":null,"index":0,"delta":{"role":"assistant","content":null}}],"created":1790124764,"id":"chatcmpl-1","model":"gateway-model","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"用戶想用"}}],"created":1790124764,"id":"chatcmpl-1","model":"gateway-model","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":" list_dir 工具"}}],"created":1790124764,"id":"chatcmpl-1","model":"gateway-model","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"id":"FskaZTFRQppln6KzKRYMuYSDkwHnoHOz","type":"function","function":{"name":"list_dir","arguments":"{"}}]}}],"created":1790124766,"id":"chatcmpl-1","model":"gateway-model","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"path\":\""}}]}}],"created":1790124766,"id":"chatcmpl-1","model":"gateway-model","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"."}}]}}],"created":1790124766,"id":"chatcmpl-1","model":"gateway-model","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\""}}]}}],"created":1790124766,"id":"chatcmpl-1","model":"gateway-model","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}],"created":1790124766,"id":"chatcmpl-1","model":"gateway-model","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}],"created":1790124766,"id":"chatcmpl-1","model":"gateway-model","object":"chat.completion.chunk","timings":{"prompt_n":4,"predicted_n":63}}

data: [DONE]

`

// chatServer 是依序回應的模擬 AI 服務：第 n 個請求拿 replies[n]，超過就重複最後一個。
// 同時把事件記下來，並換掉 HTTP client 與事件發送，測試不需要 Wails 的執行環境。
type chatServer struct {
	mu      sync.Mutex
	bodies  [][]byte
	events  []string
	onEvent func(name string)
	url     string
}

func newChatServer(t *testing.T, replies ...func(http.ResponseWriter)) *chatServer {
	t.Helper()
	s := &chatServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		n := len(s.bodies)
		s.bodies = append(s.bodies, b)
		s.mu.Unlock()
		replies[min(n, len(replies)-1)](w)
	}))
	t.Cleanup(srv.Close)
	s.url = srv.URL
	oldClient, oldEmit := httpClient, emitEvent
	t.Cleanup(func() { httpClient, emitEvent = oldClient, oldEmit })
	httpClient = srv.Client() // 不經過系統 Proxy
	emitEvent = func(_ context.Context, name string, data ...interface{}) {
		parts := []string{name}
		for _, d := range data[1:] { // data[0] 是對話 id
			parts = append(parts, fmt.Sprint(d))
		}
		s.mu.Lock()
		s.events = append(s.events, strings.Join(parts, " "))
		s.mu.Unlock()
		if s.onEvent != nil {
			s.onEvent(name)
		}
	}
	return s
}

func (s *chatServer) request(provider string) *aiRequest {
	return &aiRequest{provider: provider, baseURL: s.url, model: "m"}
}

// joined 把某種事件的內容依序接起來（串流會分批送，不比較切成幾段）
func (s *chatServer) joined(name string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var b strings.Builder
	for _, e := range s.events {
		if rest, ok := strings.CutPrefix(e, name+" "); ok {
			b.WriteString(rest)
		}
	}
	return b.String()
}

func (s *chatServer) eventLog() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.Join(s.events, "|")
}

func sseReply(chunks ...string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, c := range chunks {
			fmt.Fprintf(w, "data: %s\n\n", c)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}
}

func rawReply(body string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, body)
	}
}

func toolReply(id, name, args string) func(http.ResponseWriter) {
	quoted, _ := json.Marshal(args)
	return sseReply(fmt.Sprintf(`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":%q,"type":"function","function":{"name":%q,"arguments":%s}}]},"finish_reason":"tool_calls"}]}`, id, name, quoted))
}

func textReply(text string) func(http.ResponseWriter) {
	quoted, _ := json.Marshal(text)
	return sseReply(fmt.Sprintf(`{"choices":[{"index":0,"delta":{"content":%s},"finish_reason":"stop"}]}`, quoted))
}

func errorReply(status int, body string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}
}

func TestStreamToolCalls(t *testing.T) {
	stream := func(reply func(http.ResponseWriter)) (*streamResult, *chatServer) {
		t.Helper()
		s := newChatServer(t, reply)
		res, err := (&App{}).streamChat(context.Background(), s.request("custom"), []byte(`{}`), "id")
		if err != nil {
			t.Fatal(err)
		}
		return res, s
	}

	res, s := stream(rawReply(gatewayToolStream))
	if fmt.Sprint(res.calls) != `[{FskaZTFRQppln6KzKRYMuYSDkwHnoHOz list_dir {"path":"."}}]` || res.content != "" || res.reasoning != "用戶想用 list_dir 工具" {
		t.Errorf("閘道串流解析錯誤：%+v", res)
	}
	if s.joined("ai:think") != "用戶想用 list_dir 工具" || s.joined("ai:delta") != "" {
		t.Errorf("閘道串流的事件：%s", s.eventLog())
	}

	res, s = stream(sseReply(`{"choices":[{"index":0,"delta":{"content":"讓我查一下。"}}]}`,
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"k","type":"function","function":{"name":"search_folder","arguments":"{\"query\":\"MCP\"}"}}]}}]}`))
	if res.content != "讓我查一下。" || len(res.calls) != 1 || s.joined("ai:delta") != "讓我查一下。" {
		t.Errorf("先講話再呼叫工具：%+v %s", res, s.eventLog())
	}

	res, s = stream(sseReply(`{"choices":[{"index":0,"delta":{"content":"你好"}}]}`, `{"choices":[{"index":0,"delta":{"content":"！"},"finish_reason":"stop"}]}`))
	if res.content != "你好！" || len(res.calls) != 0 || s.joined("ai:delta") != "你好！" || s.joined("ai:think") != "" {
		t.Errorf("一般回覆的行為改變了：%+v %s", res, s.eventLog())
	}

	// 分段送完之後，最後一段又附上完整的 message：不能把參數接兩次
	full := `{"index":0,"id":"d","function":{"name":"list_dir","arguments":"{\"path\":\".\"}"}}`
	res, _ = stream(sseReply(`{"choices":[{"index":0,"delta":{"tool_calls":[`+full+`]}}]}`,
		`{"choices":[{"index":0,"delta":{},"message":{"tool_calls":[`+full+`]},"finish_reason":"tool_calls"}]}`))
	if len(res.calls) != 1 || res.calls[0].Args != `{"path":"."}` {
		t.Errorf("重複附上的 message：%+v", res.calls)
	}

	// 只給完整 message 的服務
	res, _ = stream(sseReply(`{"choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"m","function":{"name":"read_file","arguments":"{\"path\":\"a.md\"}"}}]},"finish_reason":"tool_calls"}]}`))
	if len(res.calls) != 1 || res.calls[0].Name != "read_file" || res.calls[0].Args != `{"path":"a.md"}` {
		t.Errorf("只有 message 的服務：%+v", res.calls)
	}
}

// ---- 多輪迴圈 ----

func newChatFolder(t *testing.T) string {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("hello MCP world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestChatToolsOffUnchanged(t *testing.T) {
	s := newChatServer(t, textReply("hi"))
	msgs := []AIMessage{{Role: "system", Content: "sys"}, {Role: "assistant", Content: "a", ReasoningContent: "think"}, {Role: "user", Content: "q"}}
	if err := (&App{}).runChat(context.Background(), s.request("custom"), msgs, "", "id"); err != nil {
		t.Fatal(err)
	}
	// 1.0.2 的組法：沒開工具時，請求要一個位元組都不差
	type oldMessage struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	old, _ := json.Marshal(map[string]any{"model": "m", "messages": []oldMessage{{"system", "sys"}, {"assistant", "a"}, {"user", "q"}}, "stream": true})
	if len(s.bodies) != 1 || string(s.bodies[0]) != string(old) {
		t.Errorf("關閉工具時請求變了：\n實際 %s\n應為 %s", s.bodies[0], old)
	}
}

func TestChatToolRound(t *testing.T) {
	root := newChatFolder(t)
	s := newChatServer(t,
		sseReply(`{"choices":[{"index":0,"delta":{"content":"讓我查一下。"}}]}`,
			`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"search_folder","arguments":"{\"query\":\"MCP\"}"}}]}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`),
		sseReply(`{"choices":[{"index":0,"delta":{"content":"README.md 提到 MCP。"}}],"usage":{"prompt_tokens":99,"completion_tokens":5,"total_tokens":104}}`),
	)
	if err := (&App{}).runChat(context.Background(), s.request("custom"), []AIMessage{{Role: "user", Content: "哪些檔案提到 MCP？"}}, root, "id"); err != nil {
		t.Fatal(err)
	}
	if len(s.bodies) != 2 {
		t.Fatalf("應該送兩輪，實際 %d 輪", len(s.bodies))
	}
	var second struct {
		Tools    []toolSpec        `json:"tools"`
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(s.bodies[1], &second); err != nil || len(second.Tools) != 3 || len(second.Messages) != 3 {
		t.Fatalf("第二輪請求：%s", s.bodies[1])
	}
	assistant, tool := string(second.Messages[1]), string(second.Messages[2])
	wantIn(t, "回填的 assistant 訊息", assistant, `"role":"assistant","content":"讓我查一下。"`,
		`"tool_calls":[{"id":"c1","type":"function","function":{"name":"search_folder","arguments":"{\"query\":\"MCP\"}"}}]`)
	wantNotIn(t, "非 DeepSeek 不送思考內容", assistant, "reasoning_content")
	wantIn(t, "工具結果", tool, `"role":"tool","tool_call_id":"c1"`, "README.md:1: hello MCP world")
	// 兩輪的文字之間空一行；用量只回報第一輪
	want := "ai:delta 讓我查一下。|ai:usage 10 2 12|ai:tool search_folder MCP|ai:delta \n\n|ai:delta README.md 提到 MCP。"
	if got := s.eventLog(); got != want {
		t.Errorf("事件：\n實際 %q\n應為 %q", got, want)
	}
}

func TestChatToolRoundLimit(t *testing.T) {
	root := newChatFolder(t)
	s := newChatServer(t, toolReply("", "list_dir", `{"path":"."}`)) // 永遠要求再呼叫工具
	err := (&App{}).runChat(context.Background(), s.request("custom"), []AIMessage{{Role: "user", Content: "loop"}}, root, "id")
	if err == nil || err.Error() != "AI_TOOL_LIMIT|8" {
		t.Fatalf("超過上限應該停下：%v", err)
	}
	if len(s.bodies) != maxToolRounds+1 || strings.Count(s.eventLog(), "ai:tool") != maxToolRounds {
		t.Errorf("執行了 %d 輪工具、送了 %d 個請求", strings.Count(s.eventLog(), "ai:tool"), len(s.bodies))
	}
	// 服務沒給 id 時自己補，而且每輪不重複
	wantIn(t, "補上的 id", string(s.bodies[2]), `"tool_call_id":"call_1_1"`, `"tool_call_id":"call_2_1"`)
}

func TestChatToolStop(t *testing.T) {
	root := newChatFolder(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := newChatServer(t, toolReply("c", "list_dir", `{}`), textReply("不該送到這裡"))
	s.onEvent = func(name string) {
		if name == "ai:tool" {
			cancel() // 工具執行中按下停止
		}
	}
	err := (&App{}).runChat(ctx, s.request("custom"), []AIMessage{{Role: "user", Content: "q"}}, root, "id")
	if !errors.Is(err, context.Canceled) || len(s.bodies) != 1 {
		t.Errorf("按停止後不該再送下一輪：err=%v，請求數 %d", err, len(s.bodies))
	}
}

func TestChatToolsUnsupported(t *testing.T) {
	root := newChatFolder(t)
	reject := errorReply(400, `{"error":{"message":"Unrecognized request argument supplied: tools"}}`)
	run := func(root string, replies ...func(http.ResponseWriter)) error {
		s := newChatServer(t, replies...)
		return (&App{}).runChat(context.Background(), s.request("custom"), []AIMessage{{Role: "user", Content: "q"}}, root, "id")
	}
	if err := run(root, reject); err == nil || !strings.HasPrefix(err.Error(), "AI_TOOLS_UNSUPPORTED|") {
		t.Errorf("第一輪帶 tools 被拒：%v", err)
	}
	if err := run("", reject); err == nil || !strings.HasPrefix(err.Error(), "AI_HTTP_400|") {
		t.Errorf("沒帶 tools 時照一般錯誤處理：%v", err)
	}
	if err := run(root, toolReply("c", "list_dir", `{}`), reject); err == nil || !strings.HasPrefix(err.Error(), "AI_HTTP_400|") {
		t.Errorf("第二輪才失敗，不是不支援工具：%v", err)
	}
}

func TestChatDeepSeekReasoning(t *testing.T) {
	root := newChatFolder(t)
	first := sseReply(`{"choices":[{"index":0,"delta":{"reasoning_content":"先列出檔案"}}]}`,
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"d1","type":"function","function":{"name":"list_dir","arguments":"{}"}}]}}]}`)
	msgs := []AIMessage{{Role: "user", Content: "q1"}, {Role: "assistant", Content: "a1", ReasoningContent: "舊的思考"}, {Role: "user", Content: "q2"}}
	run := func(provider, root string, replies ...func(http.ResponseWriter)) *chatServer {
		s := newChatServer(t, replies...)
		if err := (&App{}).runChat(context.Background(), s.request(provider), msgs, root, "id"); err != nil {
			t.Fatal(err)
		}
		return s
	}

	// DeepSeek 帶 tools：先前的回覆與這一輪工具往返都要附上思考內容
	s := run("deepseek", root, first, textReply("done"))
	wantIn(t, "DeepSeek 第一輪", string(s.bodies[0]), `"reasoning_content":"舊的思考"`)
	wantIn(t, "DeepSeek 第二輪", string(s.bodies[1]), `"reasoning_content":"舊的思考"`, `"reasoning_content":"先列出檔案"`)

	// 其他供應商、或 DeepSeek 沒開工具：一律不送
	for _, c := range []struct{ provider, root string }{{"custom", root}, {"deepseek", ""}} {
		s := run(c.provider, c.root, first, textReply("done"))
		for i, b := range s.bodies {
			wantNotIn(t, fmt.Sprintf("%s（資料夾 %q）第 %d 輪", c.provider, c.root, i+1), string(b), "reasoning_content")
		}
	}
}
