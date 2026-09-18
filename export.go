package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// ExportDialog 顯示匯出用的另存對話框；ext 例如 "pdf"、"docx"。取消時回傳空字串。
func (a *App) ExportDialog(title, defaultName, filterName, ext string) (string, error) {
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:            title,
		DefaultDirectory: a.docDir(),
		DefaultFilename:  defaultName,
		Filters: []runtime.FileFilter{
			{DisplayName: fmt.Sprintf("%s (*.%s)", filterName, ext), Pattern: "*." + ext},
		},
	})
	if err != nil || path == "" {
		return path, err
	}
	if filepath.Ext(path) == "" {
		path += "." + ext
	}
	return path, nil
}

// WriteBase64File 把前端產生的二進位內容（base64）寫入檔案，例如 .docx、轉換出的圖片；資料夾不存在時自動建立。
func (a *App) WriteBase64File(path, data string) error {
	b, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// ExportPDF 以 Microsoft Edge 無頭模式把獨立 HTML 列印成 PDF。
func (a *App) ExportPDF(html, outPath string) error {
	edge := findEdge()
	if edge == "" {
		return errors.New("Microsoft Edge not found")
	}
	tmp, err := os.MkdirTemp("", "docsmith-export-")
	if err != nil {
		return err
	}
	// Edge 子程序可能還佔用暫存資料夾一小段時間，背景重試清除
	defer func() {
		go func() {
			for i := 0; i < 30 && os.RemoveAll(tmp) != nil; i++ {
				time.Sleep(time.Second)
			}
		}()
	}()

	htmlPath := filepath.Join(tmp, "export.html")
	if err := os.WriteFile(htmlPath, []byte(html), 0o644); err != nil {
		return err
	}
	pdfPath := filepath.Join(tmp, "export.pdf")

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, edge,
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--user-data-dir="+filepath.Join(tmp, "profile"),
		"--no-pdf-header-footer",
		"--generate-pdf-document-outline", // 依標題產生 PDF 書籤
		"--print-to-pdf="+pdfPath,
		"file:///"+filepath.ToSlash(htmlPath),
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	// msedge.exe 啟動器會先結束、由子程序繼續列印，所以之後要等 PDF 寫完
	if out, err := cmd.CombinedOutput(); err != nil && ctx.Err() != nil {
		return fmt.Errorf("Edge print failed: %v %s", err, out)
	}
	if err := waitForFile(ctx, pdfPath); err != nil {
		return err
	}
	b, err := os.ReadFile(pdfPath)
	if err != nil {
		return err
	}
	return os.WriteFile(outPath, b, 0o644)
}

// OpenWithDefaultApp 用系統預設程式開啟檔案（例如 PDF 閱讀器、Word）。
func (a *App) OpenWithDefaultApp(path string) error {
	verb, _ := windows.UTF16PtrFromString("open")
	file, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, verb, file, nil, nil, windows.SW_SHOWNORMAL)
}

// waitForFile 等檔案出現且大小連續兩次檢查都不變、可以獨占開啟（代表已寫完）。
func waitForFile(ctx context.Context, path string) error {
	var lastSize int64 = -1
	for {
		if info, err := os.Stat(path); err == nil && info.Size() > 0 {
			if info.Size() == lastSize {
				if f, err := os.OpenFile(path, os.O_RDWR, 0); err == nil {
					f.Close()
					return nil
				}
			}
			lastSize = info.Size()
		}
		select {
		case <-ctx.Done():
			return errors.New("Edge did not produce a PDF")
		case <-time.After(300 * time.Millisecond):
		}
	}
}

func findEdge() string {
	for _, root := range []registry.Key{registry.LOCAL_MACHINE, registry.CURRENT_USER} {
		k, err := registry.OpenKey(root, `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe`, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		p, _, err := k.GetStringValue("")
		k.Close()
		if err == nil && fileExists(p) {
			return p
		}
	}
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
		p := filepath.Join(os.Getenv(env), `Microsoft\Edge\Application\msedge.exe`)
		if fileExists(p) {
			return p
		}
	}
	return ""
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}
