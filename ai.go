package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	xwin "golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// AI 服務設定（%APPDATA%\DocSmith\ai.json）。
// API 金鑰與自訂表頭的值以 Windows DPAPI 加密後存放，只有目前的 Windows 帳號能解密；
// 前端只會拿到遮罩過的字串，所有呼叫都由這裡發出。

const keepSecret = "__docsmith_keep__" // 前端以此表示「這個祕密欄位沒有變動」

var aiMu sync.Mutex

type AIHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"` // 存檔時為加密字串；回傳前端時為遮罩
}

type AIProvider struct {
	BaseURL      string     `json:"baseUrl"`
	Model        string     `json:"model"`
	Key          string     `json:"key"` // 存檔時為加密字串；不回傳前端
	Headers      []AIHeader `json:"headers"`
	Thinking     string     `json:"thinking"`     // 思考模式："" 不指定 / off / low / medium / high
	ContextLimit int        `json:"contextLimit"` // 對話長度上限（0＝依模型名稱自動判斷）
}

type AIConfig struct {
	Active    string                 `json:"active"`
	Accepted  bool                   `json:"accepted"` // 已確認資料傳送提醒
	Providers map[string]*AIProvider `json:"providers"`
}

// AIProviderView 是回傳給前端的內容（不含金鑰明文）。
type AIProviderView struct {
	BaseURL      string     `json:"baseUrl"`
	Model        string     `json:"model"`
	KeyHint      string     `json:"keyHint"` // 例如 sk-…abcd；沒有金鑰時為空
	Headers      []AIHeader `json:"headers"` // 值為遮罩
	Thinking     string     `json:"thinking"`
	ContextLimit int        `json:"contextLimit"`
}

type AIPolicy struct {
	Disabled         bool     `json:"disabled"`
	AllowedProviders []string `json:"allowedProviders"`
	LockedBaseURL    string   `json:"lockedBaseUrl"`
}

type AIConfigView struct {
	Active    string                     `json:"active"`
	Accepted  bool                       `json:"accepted"`
	Providers map[string]*AIProviderView `json:"providers"`
	Policy    AIPolicy                   `json:"policy"`
	Defaults  map[string]string          `json:"defaults"`
}

// 各供應商的預設服務網址（都使用 OpenAI 相容介面）
var aiDefaults = map[string]string{
	"openai":   "https://api.openai.com/v1",
	"gemini":   "https://generativelanguage.googleapis.com/v1beta/openai",
	"deepseek": "https://api.deepseek.com",
	"custom":   "",
}

func aiConfigPath() string {
	return filepath.Join(configDir(), "ai.json")
}

// ---- DPAPI ----
var (
	crypt32           = xwin.NewLazySystemDLL("crypt32.dll")
	procCryptProtect  = crypt32.NewProc("CryptProtectData")
	procCryptUnprotec = crypt32.NewProc("CryptUnprotectData")
)

type dataBlob struct {
	size uint32
	data *byte
}

func newBlob(b []byte) dataBlob {
	if len(b) == 0 {
		return dataBlob{}
	}
	return dataBlob{size: uint32(len(b)), data: &b[0]}
}

func (b dataBlob) bytes() []byte {
	if b.size == 0 || b.data == nil {
		return nil
	}
	out := make([]byte, b.size)
	copy(out, unsafe.Slice(b.data, b.size))
	return out
}

// encryptSecret 以目前 Windows 帳號加密（DPAPI），輸出 base64。
func encryptSecret(plain string) string {
	if plain == "" {
		return ""
	}
	in := newBlob([]byte(plain))
	var out dataBlob
	r, _, _ := procCryptProtect.Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return ""
	}
	defer xwin.LocalFree(xwin.Handle(unsafe.Pointer(out.data)))
	return base64.StdEncoding.EncodeToString(out.bytes())
}

func decryptSecret(encoded string) string {
	if encoded == "" {
		return ""
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return ""
	}
	in := newBlob(raw)
	var out dataBlob
	r, _, _ := procCryptUnprotec.Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return ""
	}
	defer xwin.LocalFree(xwin.Handle(unsafe.Pointer(out.data)))
	return string(out.bytes())
}

func maskSecret(s string) string {
	if s == "" {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= 8 {
		return strings.Repeat("•", len(runes))
	}
	return string(runes[:3]) + "…" + string(runes[len(runes)-4:])
}

// ---- 設定存取 ----
func readAIConfig() *AIConfig {
	cfg := &AIConfig{Active: "openai", Providers: map[string]*AIProvider{}}
	if b, err := os.ReadFile(aiConfigPath()); err == nil {
		_ = json.Unmarshal(b, cfg)
	}
	if cfg.Providers == nil {
		cfg.Providers = map[string]*AIProvider{}
	}
	for id, base := range aiDefaults {
		if cfg.Providers[id] == nil {
			cfg.Providers[id] = &AIProvider{BaseURL: base}
		}
		if cfg.Providers[id].BaseURL == "" && base != "" {
			cfg.Providers[id].BaseURL = base
		}
	}
	return cfg
}

func writeAIConfig(cfg *AIConfig) error {
	if err := os.MkdirAll(configDir(), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := aiConfigPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, aiConfigPath())
}

// aiPolicy 讀取公司政策（HKLM 優先，其次 HKCU）。
func aiPolicy() AIPolicy {
	policy := AIPolicy{}
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		k, err := registry.OpenKey(root, `SOFTWARE\Policies\`+productID, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		if v, _, err := k.GetIntegerValue("DisableAI"); err == nil && v != 0 {
			policy.Disabled = true
		}
		if v, _, err := k.GetStringValue("AllowedAIProviders"); err == nil && strings.TrimSpace(v) != "" {
			policy.AllowedProviders = nil
			for _, id := range strings.Split(v, ",") {
				if id = strings.TrimSpace(strings.ToLower(id)); aiDefaults[id] != "" || id == "custom" {
					policy.AllowedProviders = append(policy.AllowedProviders, id)
				}
			}
		}
		if v, _, err := k.GetStringValue("CustomBaseURL"); err == nil && strings.TrimSpace(v) != "" {
			policy.LockedBaseURL = strings.TrimSpace(v)
		}
		k.Close()
	}
	return policy
}

// GetAIConfig 回傳設定（金鑰以遮罩呈現）與公司政策。
func (a *App) GetAIConfig() *AIConfigView {
	aiMu.Lock()
	defer aiMu.Unlock()
	cfg := readAIConfig()
	policy := aiPolicy()
	view := &AIConfigView{Active: cfg.Active, Accepted: cfg.Accepted, Providers: map[string]*AIProviderView{}, Policy: policy, Defaults: aiDefaults}
	for id, p := range cfg.Providers {
		pv := &AIProviderView{BaseURL: p.BaseURL, Model: p.Model, KeyHint: maskSecret(decryptSecret(p.Key)), Thinking: p.Thinking, ContextLimit: p.ContextLimit}
		for _, h := range p.Headers {
			pv.Headers = append(pv.Headers, AIHeader{Name: h.Name, Value: maskSecret(decryptSecret(h.Value))})
		}
		view.Providers[id] = pv
	}
	if policy.LockedBaseURL != "" {
		if custom := view.Providers["custom"]; custom != nil {
			custom.BaseURL = policy.LockedBaseURL
		}
	}
	if len(policy.AllowedProviders) > 0 && !contains(policy.AllowedProviders, view.Active) {
		view.Active = policy.AllowedProviders[0]
	}
	return view
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// AISaveRequest 由前端傳入；Key / 表頭值為 keepSecret 時表示沿用已儲存的值。
type AISaveRequest struct {
	Active       string     `json:"active"`
	Provider     string     `json:"provider"`
	BaseURL      string     `json:"baseUrl"`
	Model        string     `json:"model"`
	Key          string     `json:"key"`
	Headers      []AIHeader `json:"headers"`
	Accepted     bool       `json:"accepted"`
	Thinking     string     `json:"thinking"`
	ContextLimit int        `json:"contextLimit"`
}

// SaveAIConfig 儲存單一供應商的設定。
func (a *App) SaveAIConfig(req AISaveRequest) error {
	aiMu.Lock()
	defer aiMu.Unlock()
	cfg := readAIConfig()
	if req.Active != "" {
		cfg.Active = req.Active
	}
	if req.Accepted {
		cfg.Accepted = true
	}
	if req.Provider == "" {
		return writeAIConfig(cfg)
	}
	old := cfg.Providers[req.Provider]
	if old == nil {
		old = &AIProvider{}
	}
	p := &AIProvider{BaseURL: strings.TrimSpace(req.BaseURL), Model: strings.TrimSpace(req.Model), Thinking: normalizeThinking(req.Thinking), ContextLimit: max(0, req.ContextLimit)}
	switch req.Key {
	case keepSecret:
		p.Key = old.Key
	case "":
		p.Key = ""
	default:
		p.Key = encryptSecret(req.Key)
	}
	for _, h := range req.Headers {
		if strings.TrimSpace(h.Name) == "" {
			continue
		}
		value := h.Value
		if value == keepSecret {
			value = ""
			for _, o := range old.Headers {
				if strings.EqualFold(o.Name, h.Name) {
					value = o.Value
					break
				}
			}
		} else {
			value = encryptSecret(value)
		}
		p.Headers = append(p.Headers, AIHeader{Name: strings.TrimSpace(h.Name), Value: value})
	}
	cfg.Providers[req.Provider] = p
	return writeAIConfig(cfg)
}

// ---- 呼叫 AI 服務 ----

// aiRequest 是一次呼叫所需的連線資訊（由設定或設定畫面的草稿組成）。
type aiRequest struct {
	provider string
	baseURL  string
	model    string
	key      string
	headers  []AIHeader
	thinking string // "" / off / low / medium / high
}

// 思考模式只接受固定幾個值，其他一律視為「不指定」。
func normalizeThinking(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "off", "low", "medium", "high", "xhigh", "max":
		return strings.ToLower(strings.TrimSpace(v))
	}
	return ""
}

// resolveRequest 把前端傳來的草稿與已儲存的祕密合併。
func resolveRequest(req AISaveRequest) (*aiRequest, error) {
	aiMu.Lock()
	cfg := readAIConfig()
	aiMu.Unlock()
	policy := aiPolicy()
	if policy.Disabled {
		return nil, fmt.Errorf("AI_DISABLED")
	}
	id := req.Provider
	if id == "" {
		id = cfg.Active
	}
	if len(policy.AllowedProviders) > 0 && !contains(policy.AllowedProviders, id) {
		return nil, fmt.Errorf("AI_PROVIDER_NOT_ALLOWED")
	}
	saved := cfg.Providers[id]
	if saved == nil {
		saved = &AIProvider{}
	}
	out := &aiRequest{provider: id, baseURL: strings.TrimSpace(req.BaseURL), model: strings.TrimSpace(req.Model), thinking: normalizeThinking(req.Thinking)}
	if req.Thinking == keepSecret {
		out.thinking = saved.Thinking // 對話呼叫沿用已儲存的設定
	}
	if out.baseURL == "" {
		out.baseURL = saved.BaseURL
	}
	if out.model == "" {
		out.model = saved.Model
	}
	if id == "custom" && policy.LockedBaseURL != "" {
		out.baseURL = policy.LockedBaseURL
	}
	// 只有 keepSecret 代表「沒有變動」；空字串代表使用者清除了金鑰
	if req.Key == keepSecret {
		out.key = decryptSecret(saved.Key)
	} else {
		out.key = req.Key
	}
	headers := req.Headers
	if headers == nil {
		for _, h := range saved.Headers {
			headers = append(headers, AIHeader{Name: h.Name, Value: keepSecret})
		}
	}
	for _, h := range headers {
		if strings.TrimSpace(h.Name) == "" {
			continue
		}
		value := h.Value
		if value == keepSecret {
			value = ""
			for _, o := range saved.Headers {
				if strings.EqualFold(o.Name, h.Name) {
					value = decryptSecret(o.Value)
					break
				}
			}
		}
		out.headers = append(out.headers, AIHeader{Name: strings.TrimSpace(h.Name), Value: value})
	}
	if out.baseURL == "" {
		return nil, fmt.Errorf("AI_NO_BASE_URL")
	}
	return out, nil
}

func (r *aiRequest) url(path string) string {
	return strings.TrimRight(r.baseURL, "/") + path
}

func (r *aiRequest) apply(httpReq *http.Request) {
	if r.key != "" {
		httpReq.Header.Set("Authorization", "Bearer "+r.key)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	for _, h := range r.headers {
		httpReq.Header.Set(h.Name, h.Value)
	}
}

// aiError 把 HTTP 回應轉成前端能顯示的錯誤代碼 / 訊息。
func aiError(status int, body []byte) error {
	text := strings.TrimSpace(string(body))
	if len(text) > 400 {
		text = text[:400] + "…"
	}
	var parsed struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &parsed) == nil && parsed.Error.Message != "" {
		text = parsed.Error.Message
	}
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("AI_UNAUTHORIZED|%s", text)
	case http.StatusBadRequest:
		// 部分服務（例如 Gemini）對金鑰錯誤回傳 400
		if strings.Contains(strings.ToLower(text), "api key") {
			return fmt.Errorf("AI_UNAUTHORIZED|%s", text)
		}
	case http.StatusNotFound:
		return fmt.Errorf("AI_NOT_FOUND|%s", text)
	case http.StatusTooManyRequests:
		return fmt.Errorf("AI_RATE_LIMIT|%s", text)
	}
	return fmt.Errorf("AI_HTTP_%d|%s", status, text)
}

// ListAIModels 取得服務上可用的模型清單。
func (a *App) ListAIModels(req AISaveRequest) ([]string, error) {
	ar, err := resolveRequest(req)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, ar.url("/models"), nil)
	if err != nil {
		return nil, err
	}
	ar.apply(httpReq)
	res, err := httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("AI_NETWORK|%v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return nil, aiError(res.StatusCode, body)
	}
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("AI_BAD_RESPONSE|%v", err)
	}
	models := []string{}
	for _, m := range parsed.Data {
		models = append(models, strings.TrimPrefix(m.ID, "models/"))
	}
	for _, m := range parsed.Models {
		models = append(models, strings.TrimPrefix(m.Name, "models/"))
	}
	return models, nil
}

type AITestResult struct {
	OK      bool   `json:"ok"`
	Latency int64  `json:"latency"`
	Models  int    `json:"models"`
	Message string `json:"message"`
}

// TestAIConnection 測試連線：先試模型清單，失敗時再試一次最小的對話請求。
func (a *App) TestAIConnection(req AISaveRequest) (*AITestResult, error) {
	start := time.Now()
	models, err := a.ListAIModels(req)
	if err == nil {
		return &AITestResult{OK: true, Latency: time.Since(start).Milliseconds(), Models: len(models)}, nil
	}
	firstErr := err
	// 有些服務沒有 /models（例如部分自架服務），改用一次極小的對話測試
	ar, err2 := resolveRequest(req)
	if err2 != nil {
		return nil, err2
	}
	if ar.model == "" {
		return nil, firstErr
	}
	payload, _ := json.Marshal(map[string]any{
		"model":      ar.model,
		"messages":   []map[string]string{{"role": "user", "content": "ping"}},
		"max_tokens": 1,
		"stream":     false,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, ar.url("/chat/completions"), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	ar.apply(httpReq)
	start = time.Now()
	res, err := httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("AI_NETWORK|%v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return nil, aiError(res.StatusCode, body)
	}
	return &AITestResult{OK: true, Latency: time.Since(start).Milliseconds(), Message: "chat"}, nil
}
