package main

import (
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// 檔案關聯全部寫在 HKCU（目前使用者），不需要系統管理員權限。
const (
	progID          = productID + ".Markdown"
	appDisplayName  = productName
	capabilitiesKey = `Software\` + productID + `\Capabilities`
)

var markdownExts = []string{".md", ".markdown", ".mdown", ".mkd"}

func setRegString(path, name, value string) (changed bool, err error) {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return false, err
	}
	defer k.Close()
	if old, _, err := k.GetStringValue(name); err == nil && old == value {
		return false, nil
	}
	return true, k.SetStringValue(name, value)
}

// registerFileAssociations 把本程式註冊為 Markdown 檔的可用開啟程式（出現在「開啟檔案」與「預設應用程式」中），
// 並把開啟指令指向目前 exe 的位置。不會強制改變使用者的預設程式。
func registerFileAssociations() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exeName := filepath.Base(exe)
	command := `"` + exe + `" "%1"`
	entries := [][3]string{
		{`Software\Classes\` + progID, "", "Markdown Document"},
		{`Software\Classes\` + progID + `\DefaultIcon`, "", `"` + exe + `",0`},
		{`Software\Classes\` + progID + `\shell\open\command`, "", command},
		{`Software\Classes\Applications\` + exeName, "FriendlyAppName", appDisplayName},
		{`Software\Classes\Applications\` + exeName + `\shell\open\command`, "", command},
		{capabilitiesKey, "ApplicationName", appDisplayName},
		{capabilitiesKey, "ApplicationDescription", "Markdown editor and viewer"},
		{`Software\RegisteredApplications`, appDisplayName, capabilitiesKey},
	}
	for _, ext := range markdownExts {
		entries = append(entries,
			[3]string{`Software\Classes\` + ext + `\OpenWithProgids`, progID, ""},
			[3]string{`Software\Classes\Applications\` + exeName + `\SupportedTypes`, ext, ""},
			[3]string{capabilitiesKey + `\FileAssociations`, ext, progID},
		)
	}
	changed := false
	for _, e := range entries {
		c, err := setRegString(e[0], e[1], e[2])
		if err != nil {
			return err
		}
		changed = changed || c
	}
	if changed {
		// SHCNE_ASSOCCHANGED：通知檔案總管更新圖示與開啟方式
		windows.NewLazySystemDLL("shell32.dll").NewProc("SHChangeNotify").Call(0x08000000, 0, 0, 0)
	}
	return nil
}

// IsDefaultMarkdownApp 檢查 .md 的預設開啟程式是否為本程式。
func (a *App) IsDefaultMarkdownApp() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	choice, _, err := k.GetStringValue("ProgId")
	if err != nil {
		return false
	}
	exe, _ := os.Executable()
	return strings.EqualFold(choice, progID) || strings.EqualFold(choice, `Applications\`+filepath.Base(exe))
}

// ShowDefaultAppDialog 開啟 Windows 的「選擇開啟方式」視窗，讓使用者把本程式設為 .md 的預設程式。
// Windows 10/11 不允許程式自行修改預設程式，必須由使用者在這個視窗中確認。
func (a *App) ShowDefaultAppDialog() error {
	dir := filepath.Join(os.TempDir(), productID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	sample := filepath.Join(dir, "Markdown.md")
	if !fileExists(sample) {
		if err := os.WriteFile(sample, []byte("# Markdown\n"), 0o644); err != nil {
			return err
		}
	}
	file, err := windows.UTF16PtrFromString(sample)
	if err != nil {
		return err
	}
	// OPENASINFO；OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT：可勾選「一律使用此應用程式」，不開啟範例檔
	info := struct {
		file  *uint16
		class *uint16
		flags uint32
	}{file: file, flags: 0x1 | 0x2}
	r, _, _ := windows.NewLazySystemDLL("shell32.dll").NewProc("SHOpenWithDialog").Call(0, uintptr(unsafe.Pointer(&info)))
	// 使用者按取消會回傳 HRESULT_FROM_WIN32(ERROR_CANCELLED)，不視為錯誤
	if int32(r) < 0 && uint32(r) != 0x800704C7 {
		return windows.Errno(r)
	}
	return nil
}
