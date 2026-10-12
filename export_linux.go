//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

func hideConsole(cmd *exec.Cmd) {}

func findBrowser() (string, error) {
	names := []string{
		"google-chrome-stable", "google-chrome", "chromium", "chromium-browser",
		"microsoft-edge", "microsoft-edge-stable", "brave", "brave-browser",
	}
	for _, name := range names {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	home, _ := os.UserHomeDir()
	for _, p := range []string{
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/microsoft-edge",
		"/usr/bin/microsoft-edge-stable",
		filepath.Join(home, ".local/bin/brave"),
		filepath.Join(home, ".local/bin/brave-browser"),
	} {
		if fileExists(p) {
			return p, nil
		}
	}
	return "", errors.New("no Chromium-based browser found for PDF export")
}

// OpenWithDefaultApp 用系統預設程式開啟檔案。
func (a *App) OpenWithDefaultApp(path string) error {
	return exec.Command("xdg-open", path).Start()
}
