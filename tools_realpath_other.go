//go:build !windows

package main

import "path/filepath"

func realPath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
