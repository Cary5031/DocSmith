package main

import "go/format"

// FormatGo 以 Go 官方的 gofmt 規則排版 Go 原始碼。
func (a *App) FormatGo(source string) (string, error) {
	out, err := format.Source([]byte(source))
	if err != nil {
		return "", err
	}
	return string(out), nil
}
