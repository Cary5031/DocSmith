package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// 小型資料存放（%APPDATA%\DocSmith\state.json）：閱讀位置、書籤、閱讀偏好、工作階段等。
// 每個 key 存一段前端自行定義的 JSON 字串。
var stateMu sync.Mutex

func statePath() string {
	return filepath.Join(configDir(), "state.json")
}

func readState() map[string]json.RawMessage {
	m := map[string]json.RawMessage{}
	if b, err := os.ReadFile(statePath()); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

// LoadState 取得 key 對應的 JSON 字串；沒有資料時回傳空字串。
func (a *App) LoadState(key string) string {
	stateMu.Lock()
	defer stateMu.Unlock()
	return string(readState()[key])
}

// SaveState 儲存 key 對應的 JSON 字串；value 為空字串時刪除該 key。
func (a *App) SaveState(key, value string) error {
	stateMu.Lock()
	defer stateMu.Unlock()
	m := readState()
	if value == "" {
		delete(m, key)
	} else {
		if !json.Valid([]byte(value)) {
			return os.ErrInvalid
		}
		m[key] = json.RawMessage(value)
	}
	if err := os.MkdirAll(configDir(), 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	tmp := statePath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, statePath())
}
