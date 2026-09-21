package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	xwin "golang.org/x/sys/windows"
)

// AI 對話的存放：
//
//	主要位置  <開啟的資料夾>\.DocSmith\chats\<id>.dsc（gzip 後再以 DPAPI 加密，換帳號或換電腦就解不開）
//	          沒有開啟資料夾時改放 %APPDATA%\DocSmith\chats\
//	明文備援  %APPDATA%\DocSmith\chats-backup\<id>.json（加密檔讀不到時自動改讀這份）
//
// 加密只擋得住「把專案目錄整個複製走」這種情況；備援檔是明文，拿到的人就讀得到。
// 這是使用者權衡後的決定：寧可讀得回來，也不要因為換帳號就永久遺失。

const (
	chatDirName    = ".DocSmith"
	chatExt        = ".dsc"
	chatMaxPerRoot = 100 // 每個資料夾保留的對話組數
)

var (
	chatRootMu sync.RWMutex
	chatRoot   string // 目前開啟的資料夾，空字串代表沒有
	chatIDRe   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// ChatMeta 是對話紀錄清單需要的欄位。
type ChatMeta struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Updated int64  `json:"updated"` // 毫秒
	Count   int    `json:"count"`   // 訊息則數
	Backup  bool   `json:"backup"`  // 這筆是從明文備援讀回來的
}

// SetChatFolder 設定對話要存到哪個專案資料夾（前端在開啟 / 關閉資料夾時呼叫）。
func (a *App) SetChatFolder(folder string) {
	chatRootMu.Lock()
	chatRoot = strings.TrimSpace(folder)
	chatRootMu.Unlock()
}

// ChatFolder 回傳目前對話實際存放的資料夾，供介面顯示。
func (a *App) ChatFolder() string {
	return chatDir()
}

func chatDir() string {
	chatRootMu.RLock()
	root := chatRoot
	chatRootMu.RUnlock()
	if root != "" {
		if info, err := os.Stat(root); err == nil && info.IsDir() {
			return filepath.Join(root, chatDirName, "chats")
		}
	}
	return filepath.Join(configDir(), "chats")
}

// chatBackupDir 依目前資料夾分出子目錄，讓各專案的備援互不混雜。
func chatBackupDir() string {
	return filepath.Join(configDir(), "chats-backup", chatFolderKey())
}

// chatFolderKey 把資料夾路徑轉成固定長度的代號（沒有資料夾時為 default）。
func chatFolderKey() string {
	chatRootMu.RLock()
	root := chatRoot
	chatRootMu.RUnlock()
	if root == "" {
		return "default"
	}
	sum := sha1.Sum([]byte(strings.ToLower(filepath.Clean(root))))
	return hex.EncodeToString(sum[:8])
}

// ensureChatDir 建立資料夾，並在 .DocSmith 下放一個忽略自己的 .gitignore。
func ensureChatDir() (string, error) {
	dir := chatDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if parent := filepath.Dir(dir); filepath.Base(parent) == chatDirName {
		ignore := filepath.Join(parent, ".gitignore")
		if _, err := os.Stat(ignore); os.IsNotExist(err) {
			_ = os.WriteFile(ignore, []byte("*\n"), 0o600)
		}
	}
	return dir, nil
}

// ---- 壓縮與加密 ----

func gzipBytes(raw []byte) ([]byte, error) {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write(raw); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func gunzipBytes(raw []byte) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(r)
}

// protectBytes / unprotectBytes 是 DPAPI 的位元組版本（金鑰用的是字串版）。
func protectBytes(raw []byte) ([]byte, error) {
	in := newBlob(raw)
	var out dataBlob
	r, _, err := procCryptProtect.Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, fmt.Errorf("CryptProtectData: %v", err)
	}
	defer xwin.LocalFree(xwin.Handle(unsafe.Pointer(out.data)))
	return out.bytes(), nil
}

func unprotectBytes(raw []byte) ([]byte, error) {
	in := newBlob(raw)
	var out dataBlob
	r, _, err := procCryptUnprotec.Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, fmt.Errorf("CryptUnprotectData: %v", err)
	}
	defer xwin.LocalFree(xwin.Handle(unsafe.Pointer(out.data)))
	return out.bytes(), nil
}

// ---- 讀寫 ----

func chatPath(dir, id string) string { return filepath.Join(dir, id+chatExt) }

func backupPath(id string) string { return filepath.Join(chatBackupDir(), id+".json") }

// SaveChat 存一組對話；data 是前端的 JSON 字串。
func (a *App) SaveChat(id, data string) error {
	if !chatIDRe.MatchString(id) {
		return os.ErrInvalid
	}
	dir, err := ensureChatDir()
	if err != nil {
		return err
	}
	packed, err := gzipBytes([]byte(data))
	if err != nil {
		return err
	}
	sealed, err := protectBytes(packed)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(chatPath(dir, id), sealed); err != nil {
		return err
	}
	// 明文備援：寫失敗不影響主要流程
	if err := os.MkdirAll(chatBackupDir(), 0o700); err == nil {
		_ = writeFileAtomic(backupPath(id), []byte(data))
	}
	pruneChats(dir)
	return nil
}

// LoadChat 讀一組對話；加密檔讀不到時改讀明文備援。
func (a *App) LoadChat(id string) (string, error) {
	if !chatIDRe.MatchString(id) {
		return "", os.ErrInvalid
	}
	if raw, err := os.ReadFile(chatPath(chatDir(), id)); err == nil {
		if data, err := openChatBytes(raw); err == nil {
			return string(data), nil
		}
	}
	raw, err := os.ReadFile(backupPath(id))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// DeleteChat 刪除一組對話（主檔與備援都刪）。
func (a *App) DeleteChat(id string) error {
	if !chatIDRe.MatchString(id) {
		return os.ErrInvalid
	}
	err := os.Remove(chatPath(chatDir(), id))
	if os.IsNotExist(err) {
		err = nil
	}
	if rmErr := os.Remove(backupPath(id)); rmErr != nil && !os.IsNotExist(rmErr) && err == nil {
		err = rmErr
	}
	return err
}

// ListChats 回傳目前資料夾的對話清單，最新的在前面。
func (a *App) ListChats() ([]ChatMeta, error) {
	dir := chatDir()
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	metas := []ChatMeta{}
	seen := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), chatExt) {
			continue
		}
		id := strings.TrimSuffix(e.Name(), chatExt)
		if !chatIDRe.MatchString(id) {
			continue
		}
		seen[id] = true
		meta, ok := readMeta(filepath.Join(dir, e.Name()), id)
		if !ok {
			// 解不開就改讀明文備援
			if meta, ok = readBackupMeta(id); !ok {
				continue
			}
			meta.Backup = true
		}
		metas = append(metas, meta)
	}
	// 主檔不在了（例如換了電腦）但備援還在的，也一起列出來
	if backups, err := os.ReadDir(chatBackupDir()); err == nil {
		for _, e := range backups {
			id := strings.TrimSuffix(e.Name(), ".json")
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") || seen[id] || !chatIDRe.MatchString(id) {
				continue
			}
			if meta, ok := readBackupMeta(id); ok {
				meta.Backup = true
				metas = append(metas, meta)
			}
		}
	}
	sort.Slice(metas, func(i, j int) bool { return metas[i].Updated > metas[j].Updated })
	return metas, nil
}

func openChatBytes(raw []byte) ([]byte, error) {
	packed, err := unprotectBytes(raw)
	if err != nil {
		return nil, err
	}
	return gunzipBytes(packed)
}

func metaFrom(data []byte, id string) (ChatMeta, bool) {
	var doc struct {
		ID       string            `json:"id"`
		Title    string            `json:"title"`
		Updated  int64             `json:"updated"`
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return ChatMeta{}, false
	}
	if doc.ID == "" {
		doc.ID = id
	}
	return ChatMeta{ID: doc.ID, Title: doc.Title, Updated: doc.Updated, Count: len(doc.Messages)}, true
}

func readMeta(path, id string) (ChatMeta, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ChatMeta{}, false
	}
	data, err := openChatBytes(raw)
	if err != nil {
		return ChatMeta{}, false
	}
	return metaFrom(data, id)
}

func readBackupMeta(id string) (ChatMeta, bool) {
	raw, err := os.ReadFile(backupPath(id))
	if err != nil {
		return ChatMeta{}, false
	}
	return metaFrom(raw, id)
}

// pruneChats 只保留最近 chatMaxPerRoot 組。
func pruneChats(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type item struct {
		id      string
		updated int64
	}
	items := []item{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), chatExt) {
			continue
		}
		id := strings.TrimSuffix(e.Name(), chatExt)
		meta, ok := readMeta(filepath.Join(dir, e.Name()), id)
		if !ok {
			info, err := e.Info()
			if err != nil {
				continue
			}
			meta.Updated = info.ModTime().UnixMilli()
		}
		items = append(items, item{id: id, updated: meta.Updated})
	}
	if len(items) <= chatMaxPerRoot {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].updated > items[j].updated })
	for _, old := range items[chatMaxPerRoot:] {
		_ = os.Remove(chatPath(dir, old.id))
		_ = os.Remove(backupPath(old.id))
	}
}

func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// PickChatBackup 讓使用者選一個備份 JSON 檔（還原用）。
func (a *App) PickChatBackup(title, filterName string) (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   title,
		Filters: []runtime.FileFilter{{DisplayName: filterName, Pattern: "*.json"}},
	})
}
