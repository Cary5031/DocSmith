//go:build windows

package main

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func ensureUpdateSupported() error { return nil }

func platformProxy() (*url.URL, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return nil, nil
	}
	defer k.Close()
	if enabled, _, err := k.GetIntegerValue("ProxyEnable"); err != nil || enabled == 0 {
		return nil, nil
	}
	server, _, err := k.GetStringValue("ProxyServer")
	if err != nil || server == "" {
		return nil, nil
	}
	// 可能是 "host:port" 或 "http=host:port;https=host:port"
	for _, part := range strings.Split(server, ";") {
		if kv := strings.SplitN(part, "=", 2); len(kv) == 2 {
			if kv[0] == "https" {
				server = kv[1]
				break
			}
		} else {
			server = part
		}
	}
	if !strings.Contains(server, "://") {
		server = "http://" + server
	}
	return url.Parse(server)
}

func waitPid(pid int, timeout time.Duration) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return
	}
	windows.WaitForSingleObject(h, uint32(timeout.Milliseconds()))
	windows.CloseHandle(h)
}

// applyElevated 沒有寫入權限時，以系統管理員身分（UAC）執行 PowerShell 完成替換並重新啟動。
func (a *App) applyElevated(exe, newFile string) error {
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	script := fmt.Sprintf(
		"$ErrorActionPreference='Stop'; Wait-Process -Id %d -Timeout 30 -ErrorAction SilentlyContinue; "+
			"Move-Item -Force -LiteralPath %s -Destination %s; Move-Item -Force -LiteralPath %s -Destination %s; "+
			"Start-Process -FilePath %s -ArgumentList '--updated'",
		os.Getpid(), quote(exe), quote(exe+".old"), quote(newFile), quote(exe), quote(exe))
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString("powershell.exe")
	args, _ := windows.UTF16PtrFromString("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"" + script + "\"")
	if err := windows.ShellExecute(0, verb, file, args, nil, windows.SW_HIDE); err != nil {
		return err // 使用者在 UAC 按「否」
	}
	a.Quit()
	return nil
}
