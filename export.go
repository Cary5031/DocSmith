package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
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

// ExportPDF 以 Chromium 系瀏覽器的無頭模式把獨立 HTML 列印成 PDF。
func (a *App) ExportPDF(html, outPath string) error {
	browser, err := findBrowser()
	if err != nil {
		return err
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
	cmd := exec.CommandContext(ctx, browser,
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
	hideConsole(cmd)
	// 瀏覽器啟動器可能先結束、由子程序繼續列印，所以之後要等 PDF 寫完
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

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}
