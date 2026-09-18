package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// DirEntry 是檔案總管的一個項目。
type DirEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// 檔案總管不顯示的資料夾（版本控制、套件、建置產物）
var hiddenDirs = map[string]bool{
	".git": true, ".svn": true, ".hg": true, "node_modules": true, "__pycache__": true, ".vs": true, ".idea": true,
}

// OpenFolderDialog 顯示選擇資料夾對話框，取消時回傳空字串。
func (a *App) OpenFolderDialog(title string) (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: title})
}

// ListDir 列出資料夾內容：資料夾在前，名稱不分大小寫排序。
func (a *App) ListDir(dir string) ([]DirEntry, error) {
	items, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	entries := make([]DirEntry, 0, len(items))
	for _, item := range items {
		name := item.Name()
		isDir := item.IsDir()
		if isDir && hiddenDirs[name] {
			continue
		}
		entry := DirEntry{Name: name, Path: filepath.Join(dir, name), IsDir: isDir}
		if !isDir {
			if info, err := item.Info(); err == nil {
				entry.Size = info.Size()
			}
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, nil
}

// PathExists 檢查檔案或資料夾是否存在（還原上次開啟的資料夾時使用）。
func (a *App) PathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
