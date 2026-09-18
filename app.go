package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Settings 是使用者偏好，存在 %APPDATA%\DocSmith\settings.json
type Settings struct {
	Language      string `json:"language"`
	DefaultPrompt string `json:"defaultPrompt"` // "never"：不再詢問是否設為預設程式
}

// App 提供給前端呼叫的方法。
type App struct {
	ctx context.Context

	mu        sync.Mutex
	docPath   string // 目前文件路徑，預覽用它來解析相對路徑圖片
	dirty     bool
	forceQuit bool
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// 註冊 .md 檔案關聯（HKCU），失敗不影響使用
	go registerFileAssociations()
}

// onSecondInstance：程式已在執行時又被開啟（例如雙擊 .md），把檔案交給前端開成分頁並帶到最前面。
func (a *App) onSecondInstance(data options.SecondInstanceData) {
	files := []string{}
	for _, arg := range data.Args {
		if strings.HasPrefix(arg, "-") {
			continue
		}
		if !filepath.IsAbs(arg) {
			arg = filepath.Join(data.WorkingDirectory, arg)
		}
		files = append(files, filepath.Clean(arg))
	}
	runtime.WindowUnminimise(a.ctx)
	runtime.WindowShow(a.ctx)
	runtime.WindowSetAlwaysOnTop(a.ctx, true)
	runtime.WindowSetAlwaysOnTop(a.ctx, false)
	if len(files) > 0 {
		runtime.EventsEmit(a.ctx, "open-files", files)
	}
}

// beforeClose：有未存變更時先攔下，交給前端詢問使用者。
func (a *App) beforeClose(ctx context.Context) (prevent bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.forceQuit || !a.dirty {
		return false
	}
	runtime.EventsEmit(ctx, "close-requested")
	return true
}

// Quit 由前端在使用者確認後呼叫，略過未存檔檢查直接關閉。
func (a *App) Quit() {
	a.mu.Lock()
	a.forceQuit = true
	a.mu.Unlock()
	runtime.Quit(a.ctx)
}

func (a *App) SetDirty(dirty bool) {
	a.mu.Lock()
	a.dirty = dirty
	a.mu.Unlock()
}

// SetDocPath 設定目前文件路徑（新文件傳空字串）。
func (a *App) SetDocPath(path string) {
	a.mu.Lock()
	a.docPath = path
	a.mu.Unlock()
}

func (a *App) docDir() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.docPath == "" {
		return ""
	}
	return filepath.Dir(a.docPath)
}

// GetStartupFiles 回傳命令列帶進來的檔案路徑（例如「開啟檔案 → 選擇此程式」）。
func (a *App) GetStartupFiles() []string {
	return filesFromArgs(os.Args[1:])
}

func filesFromArgs(args []string) []string {
	files := []string{}
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			continue
		}
		if abs, err := filepath.Abs(arg); err == nil {
			arg = abs
		}
		files = append(files, arg)
	}
	return files
}

// ResolvePath 把預覽中的相對連結轉成絕對路徑（以目前文件所在資料夾為基準）。
func (a *App) ResolvePath(rel string) string {
	if filepath.IsAbs(rel) {
		return filepath.Clean(rel)
	}
	dir := a.docDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, filepath.FromSlash(rel))
}

func markdownFilters(filterName, allName string) []runtime.FileFilter {
	return []runtime.FileFilter{
		{DisplayName: filterName + " (*.md;*.markdown)", Pattern: "*.md;*.markdown;*.mdown;*.mkd"},
		{DisplayName: allName + " (*.*)", Pattern: "*.*"},
	}
}

// 可自動轉換成 Markdown 的文件格式
// 開啟對話框「所有支援的文件」包含的格式（任何文字檔也都能以「所有檔案」開啟）
const supportedPattern = "*.md;*.markdown;*.mdown;*.mkd;*.txt;*.log;*.csv;*.tsv;*.json;*.yaml;*.yml;*.xml;*.html;*.htm;*.css;*.js;*.ts;*.jsx;*.tsx;*.py;*.go;*.cs;*.java;*.c;*.cpp;*.h;*.hpp;*.rs;*.php;*.rb;*.sql;*.ps1;*.sh;*.bat;*.ini;*.toml;*.docx;*.xlsx;*.xls;*.ods;*.pptx;*.pdf;*.epub;*.mobi;*.azw3;*.fb2;*.cbz"

// OpenFileDialog 顯示開啟檔案對話框（可多選），取消時回傳空陣列。
func (a *App) OpenFileDialog(title, supportedName, filterName, allName string) ([]string, error) {
	return runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            title,
		DefaultDirectory: a.docDir(),
		Filters: append([]runtime.FileFilter{
			{DisplayName: supportedName, Pattern: supportedPattern},
		}, markdownFilters(filterName, allName)...),
	})
}

// ReadFileBase64 讀取二進位檔（供前端轉換 Word / Excel / PDF 等格式）。
func (a *App) ReadFileBase64(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

// ImportTarget 是轉換文件時建議的輸出位置。
type ImportTarget struct {
	MarkdownPath string `json:"markdownPath"` // 原檔旁的 .md（不覆蓋既有檔案）
	AssetsDir    string `json:"assetsDir"`    // 圖片資料夾名稱（相對於 .md）
}

// ImportTargets 依來源檔案計算輸出 .md 路徑與圖片資料夾，已存在（或已被分頁佔用，taken）時加上編號。
func (a *App) ImportTargets(src string, taken []string) ImportTarget {
	dir := filepath.Dir(src)
	base := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
	for i := 0; ; i++ {
		name := base
		if i > 0 {
			name = fmt.Sprintf("%s-%d", base, i)
		}
		md := filepath.Join(dir, name+".md")
		assets := name + "_images"
		if !fileExists(md) && !dirExists(filepath.Join(dir, assets)) && !containsFold(taken, md) {
			return ImportTarget{MarkdownPath: md, AssetsDir: assets}
		}
	}
}

func containsFold(list []string, s string) bool {
	for _, v := range list {
		if strings.EqualFold(v, s) {
			return true
		}
	}
	return false
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

// SaveFileDialog 顯示另存新檔對話框，取消時回傳空字串；沒有副檔名時自動補 .md。
func (a *App) SaveFileDialog(title, defaultName, filterName, allName string) (string, error) {
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:            title,
		DefaultDirectory: a.docDir(),
		DefaultFilename:  defaultName,
		Filters:          markdownFilters(filterName, allName),
	})
	if err != nil || path == "" {
		return path, err
	}
	if filepath.Ext(path) == "" {
		path += ".md"
	}
	return path, nil
}

func configDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, productID)
}

func userDataPath() string {
	return filepath.Join(configDir(), "WebView2")
}

func settingsPath() string {
	return filepath.Join(configDir(), "settings.json")
}

// LoadSettings 讀取設定；檔案不存在時回傳空設定（前端依系統語言決定預設值）。
func (a *App) LoadSettings() Settings {
	var s Settings
	if b, err := os.ReadFile(settingsPath()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}

func (a *App) SaveSettings(s Settings) error {
	if err := os.MkdirAll(configDir(), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(settingsPath(), b, 0o644)
}
