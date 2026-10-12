//go:build windows

package main

import (
	"os"
	"strings"

	xwin "golang.org/x/sys/windows"
)

// realPath 回傳檔案實際所在的位置，會解開 symlink、junction 等所有連結。
// 不用 filepath.EvalSymlinks：Go 1.23 起它在 Windows 不再解開 junction（winsymlink=1）。
func realPath(path string) (string, error) {
	name, err := xwin.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	h, err := xwin.CreateFile(name, 0, xwin.FILE_SHARE_READ|xwin.FILE_SHARE_WRITE|xwin.FILE_SHARE_DELETE,
		nil, xwin.OPEN_EXISTING, xwin.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer xwin.CloseHandle(h)
	buf := make([]uint16, xwin.MAX_PATH)
	for {
		n, err := xwin.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
		if err != nil {
			return "", err
		}
		if int(n) < len(buf) {
			s := xwin.UTF16ToString(buf[:n])
			if rest, ok := strings.CutPrefix(s, `\\?\UNC\`); ok {
				return `\\` + rest, nil
			}
			return strings.TrimPrefix(s, `\\?\`), nil
		}
		buf = make([]uint16, n) // 空間不夠時 n 是需要的長度
	}
}
