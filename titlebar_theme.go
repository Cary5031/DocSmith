package main

import "github.com/wailsapp/wails/v2/pkg/options/windows"

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
