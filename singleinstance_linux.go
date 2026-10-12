//go:build !windows

package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/options"
)

var (
	secondInstanceMu       sync.Mutex
	secondInstanceHandler  func(options.SecondInstanceData)
	pendingSecondInstances []options.SecondInstanceData
)

func setSecondInstanceHandler(fn func(options.SecondInstanceData)) {
	secondInstanceMu.Lock()
	secondInstanceHandler = fn
	pending := pendingSecondInstances
	pendingSecondInstances = nil
	secondInstanceMu.Unlock()
	for _, data := range pending {
		fn(data)
	}
}

func deliverSecondInstance(data options.SecondInstanceData) {
	secondInstanceMu.Lock()
	fn := secondInstanceHandler
	if fn == nil {
		pendingSecondInstances = append(pendingSecondInstances, data)
	}
	secondInstanceMu.Unlock()
	if fn != nil {
		go fn(data)
	}
}

func instanceSocketPath() string {
	return filepath.Join(configDir(), "instance.sock")
}

// ensureSingleInstance 回傳 false 表示已把參數轉交給既有程式，本程式應直接結束。
func ensureSingleInstance() bool {
	if forwardToExisting() {
		return false
	}
	go runInstanceSocket()
	return true
}

func forwardToExisting() bool {
	conn, err := net.DialTimeout("unix", instanceSocketPath(), 300*time.Millisecond)
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	cwd, _ := os.Getwd()
	payload, _ := json.Marshal(options.SecondInstanceData{Args: os.Args[1:], WorkingDirectory: cwd})
	if _, err := conn.Write(append(payload, '\n')); err != nil {
		return false
	}
	buf := make([]byte, 1)
	n, err := conn.Read(buf)
	return err == nil && n == 1 && buf[0] == '1'
}

func runInstanceSocket() {
	path := instanceSocketPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return
	}
	_ = os.Chmod(path, 0o600)
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go serveInstance(conn)
	}
}

func serveInstance(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	var data options.SecondInstanceData
	if err := json.NewDecoder(conn).Decode(&data); err != nil {
		_, _ = conn.Write([]byte("0"))
		return
	}
	deliverSecondInstance(data)
	_, _ = conn.Write([]byte("1"))
}
