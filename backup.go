package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

// 未存檔內容的備份（%APPDATA%\DocSmith\backup\<id>.json），用於當機復原。
// 內容由前端決定（JSON 字串），這裡只負責存取。

var backupIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func backupDir() string {
	return filepath.Join(configDir(), "backup")
}

// WriteBackup 寫入一份備份。
func (a *App) WriteBackup(id, data string) error {
	if !backupIDPattern.MatchString(id) {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(backupDir(), 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(backupDir(), id+".tmp")
	if err := os.WriteFile(tmp, []byte(data), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(backupDir(), id+".json"))
}

// DeleteBackup 刪除一份備份（不存在時不視為錯誤）。
func (a *App) DeleteBackup(id string) error {
	if !backupIDPattern.MatchString(id) {
		return os.ErrInvalid
	}
	err := os.Remove(filepath.Join(backupDir(), id+".json"))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// ListBackups 回傳所有備份的內容（依修改時間排序）。
func (a *App) ListBackups() []string {
	files, _ := filepath.Glob(filepath.Join(backupDir(), "*.json"))
	sort.Slice(files, func(i, j int) bool {
		fi, _ := os.Stat(files[i])
		fj, _ := os.Stat(files[j])
		return fi != nil && fj != nil && fi.ModTime().Before(fj.ModTime())
	})
	out := []string{}
	for _, f := range files {
		if b, err := os.ReadFile(f); err == nil {
			out = append(out, string(b))
		}
	}
	return out
}

// ClearBackups 刪除所有備份（正常關閉或使用者選擇捨棄時）。
func (a *App) ClearBackups() error {
	files, _ := filepath.Glob(filepath.Join(backupDir(), "*"))
	for _, f := range files {
		os.Remove(f)
	}
	return nil
}
