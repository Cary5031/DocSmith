//go:build !windows

package main

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed build/appicon.png
var appIconPNG []byte

func desktopFilePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "applications", "DocSmith.desktop")
}

func iconInstallPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "icons", "hicolor", "256x256", "apps", "docsmith.png")
}

// registerFileAssociations 把本程式登記成 Markdown 的可用開啟程式，不改目前的預設程式。
func registerFileAssociations() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	icon := iconInstallPath()
	if err := os.MkdirAll(filepath.Dir(icon), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(icon, appIconPNG, 0o644); err != nil {
		return err
	}
	desktop := desktopFilePath()
	if err := os.MkdirAll(filepath.Dir(desktop), 0o755); err != nil {
		return err
	}
	content := fmt.Sprintf(`[Desktop Entry]
Name=DocSmith
Name[zh_TW]=文匠
Comment=閱讀、撰寫、AI 協作的文件工作台
Exec=%s %%f
Icon=%s
Terminal=false
Type=Application
Categories=Office;TextEditor;
MimeType=text/markdown;text/x-markdown;application/x-markdown;
StartupWMClass=DocSmith
`, exe, icon)
	return os.WriteFile(desktop, []byte(content), 0o644)
}

func (a *App) IsDefaultMarkdownApp() bool {
	out, err := exec.Command("xdg-mime", "query", "default", "text/markdown").Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "DocSmith.desktop"
}

// ShowDefaultAppDialog 在使用者已於程式內確認後，把 DocSmith 設為 Markdown 的預設開啟程式。
func (a *App) ShowDefaultAppDialog() error {
	if err := registerFileAssociations(); err != nil {
		return err
	}
	for _, mime := range []string{"text/markdown", "text/x-markdown", "application/x-markdown"} {
		if out, err := exec.Command("xdg-mime", "default", "DocSmith.desktop", mime).CombinedOutput(); err != nil {
			return fmt.Errorf("xdg-mime: %v %s", err, out)
		}
	}
	return nil
}
