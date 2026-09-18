package main

import (
	"os"
	"unsafe"

	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	xwin "golang.org/x/sys/windows"
)

// 視窗標題列跟著介面主題切換深 / 淺色。
// Windows 10 設定 DWMWA_USE_IMMERSIVE_DARK_MODE 後不會立即重畫標題列，
// 所以這裡自行設定並強制重畫非工作區。

var (
	user32            = xwin.NewLazySystemDLL("user32.dll")
	dwmapi            = xwin.NewLazySystemDLL("dwmapi.dll")
	procSendMessage   = user32.NewProc("SendMessageW")
	procEnumWindows   = user32.NewProc("EnumWindows")
	procGetClassName  = user32.NewProc("GetClassNameW")
	procGetWindowPID  = user32.NewProc("GetWindowThreadProcessId")
	procGetForeground = user32.NewProc("GetForegroundWindow")
	procDwmSetAttr    = dwmapi.NewProc("DwmSetWindowAttribute")
)

const wmNCActivate = 0x0086

// mainWindow 找出本程式的 Wails 主視窗。
func mainWindow() uintptr {
	pid := uint32(os.Getpid())
	var found uintptr
	cb := xwin.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		var owner uint32
		procGetWindowPID.Call(hwnd, uintptr(unsafe.Pointer(&owner)))
		if owner != pid {
			return 1
		}
		buf := make([]uint16, 64)
		procGetClassName.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), 64)
		if xwin.UTF16ToString(buf) == "wailsWindow" {
			found = hwnd
			return 0
		}
		return 1
	})
	procEnumWindows.Call(cb, 0)
	return found
}

// SetTitleBarDark 由前端在主題改變時呼叫。
func (a *App) SetTitleBarDark(dark bool) {
	// 讓 Wails 記住目前主題（系統主題變更時它會依此重設）
	if dark {
		runtime.WindowSetDarkTheme(a.ctx)
	} else {
		runtime.WindowSetLightTheme(a.ctx)
	}
	hwnd := mainWindow()
	if hwnd == 0 {
		return
	}
	var value int32
	if dark {
		value = 1
	}
	// 20 = DWMWA_USE_IMMERSIVE_DARK_MODE（Windows 10 20H1 以後），19 為較舊版本
	if r, _, _ := procDwmSetAttr.Call(hwnd, 20, uintptr(unsafe.Pointer(&value)), 4); r != 0 {
		procDwmSetAttr.Call(hwnd, 19, uintptr(unsafe.Pointer(&value)), 4)
	}
	// 強制重畫標題列：先送出相反的啟用狀態，再還原
	fg, _, _ := procGetForeground.Call()
	active := uintptr(0)
	if fg == hwnd {
		active = 1
	}
	procSendMessage.Call(hwnd, wmNCActivate, 1-active, 0)
	procSendMessage.Call(hwnd, wmNCActivate, active, 0)
}

// initialTheme 依上次的設定決定建立視窗時的標題列主題，避免啟動時先閃一下亮色。
func initialTheme() windows.Theme {
	switch loadSettings().Theme {
	case "dark":
		return windows.Dark
	case "light":
		return windows.Light
	default:
		return windows.SystemDefault
	}
}
