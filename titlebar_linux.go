//go:build !windows

package main

import "github.com/wailsapp/wails/v2/pkg/runtime"

// SetTitleBarDark 由前端在主題改變時呼叫。Linux 沒有 DWM 標題列，
// 無框視窗只需要讓 WebKit 跟著深淺色主題。
func (a *App) SetTitleBarDark(dark bool) {
	if dark {
		runtime.WindowSetDarkTheme(a.ctx)
		return
	}
	runtime.WindowSetLightTheme(a.ctx)
}
