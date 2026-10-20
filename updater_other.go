//go:build !windows

package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"time"
)

func ensureUpdateSupported() error {
	return errors.New("automatic updates install the Windows executable; on Linux, update the local build instead")
}

func platformProxy() (*url.URL, error) { return nil, nil }

func waitPid(pid int, timeout time.Duration) {
	if _, err := os.Stat("/proc"); err != nil {
		time.Sleep(timeout)
		return
	}
	proc := fmt.Sprintf("/proc/%d", pid)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(proc); err != nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func (a *App) applyElevated(exe, newFile string) error {
	return fmt.Errorf("cannot replace %s: permission denied", exe)
}
