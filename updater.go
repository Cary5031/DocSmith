package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// 編譯時內嵌的版本資訊（publish.ps1 會先更新 version.json 再建置）
//
//go:embed version.json
var embeddedVersion []byte

// GitHub 上的最新版本資訊
const latestVersionURL = "https://raw.githubusercontent.com/" + githubRepo + "/main/version.json"

type VersionInfo struct {
	Version     string            `json:"version"`
	ReleaseDate string            `json:"releaseDate"`
	DownloadURL string            `json:"downloadUrl"`
	SHA256      string            `json:"sha256"`
	Notes       map[string]string `json:"notes"`
}

type UpdateCheck struct {
	Current   string      `json:"current"`
	Available bool        `json:"available"`
	Latest    VersionInfo `json:"latest"`
}

func currentVersion() string {
	var v VersionInfo
	_ = json.Unmarshal(embeddedVersion, &v)
	return v.Version
}

// GetVersion 回傳目前程式版本。
func (a *App) GetVersion() string {
	return currentVersion()
}

// WasUpdated 表示這次啟動是否剛完成自動更新（由舊版以 --updated 參數啟動）。
func (a *App) WasUpdated() bool {
	for _, arg := range os.Args[1:] {
		if arg == "--updated" {
			return true
		}
	}
	return false
}

// newerVersion 比較 x.y.z 版本號，latest 較新時回傳 true。
func newerVersion(latest, current string) bool {
	parse := func(v string) [3]int {
		var out [3]int
		for i, part := range strings.SplitN(strings.TrimPrefix(v, "v"), ".", 3) {
			out[i], _ = strconv.Atoi(part)
		}
		return out
	}
	l, c := parse(latest), parse(current)
	for i := range l {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}

// systemProxy 讀取環境變數或 Windows 的 Proxy 設定（不支援 PAC 自動設定指令碼）。
func systemProxy(req *http.Request) (*url.URL, error) {
	if p, err := http.ProxyFromEnvironment(req); p != nil || err != nil {
		return p, err
	}
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

var httpClient = &http.Client{Transport: &http.Transport{Proxy: systemProxy}}

func fetchLatest(ctx context.Context) (*VersionInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, latestVersionURL, nil)
	if err != nil {
		return nil, err
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var info VersionInfo
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&info); err != nil {
		return nil, err
	}
	if info.Version == "" || info.DownloadURL == "" {
		return nil, errors.New("invalid version.json")
	}
	return &info, nil
}

// CheckForUpdate 檢查 GitHub 是否有新版本；離線或連線失敗時回傳錯誤，前端會靜默略過。
func (a *App) CheckForUpdate() (*UpdateCheck, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	latest, err := fetchLatest(ctx)
	if err != nil {
		return nil, err
	}
	current := currentVersion()
	return &UpdateCheck{Current: current, Available: newerVersion(latest.Version, current), Latest: *latest}, nil
}

// pinnedDownloadURL 查出最後一次修改 exe 的 commit，改用該 commit 的固定網址下載。
// main 分支的 raw 網址有 CDN 快取，剛推送的幾分鐘內可能還拿到舊檔；固定網址的內容不會變。
// 查詢失敗時回傳原本的網址（下載後仍有 SHA-256 驗證）。
func pinnedDownloadURL(ctx context.Context, fallback string) string {
	api := "https://api.github.com/repos/" + githubRepo + "/commits?path=build/bin/" + exeName + "&sha=main&per_page=1"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, api, nil)
	if err != nil {
		return fallback
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := httpClient.Do(req)
	if err != nil {
		return fallback
	}
	defer res.Body.Close()
	var commits []struct {
		SHA string `json:"sha"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&commits) != nil || len(commits) == 0 {
		return fallback
	}
	return "https://raw.githubusercontent.com/" + githubRepo + "/" + commits[0].SHA + "/build/bin/" + exeName
}

type progressWriter struct {
	ctx      context.Context
	total    int64
	done     int64
	lastSent int
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if p.total > 0 {
		if pct := int(p.done * 100 / p.total); pct != p.lastSent {
			p.lastSent = pct
			runtime.EventsEmit(p.ctx, "update-progress", pct)
		}
	}
	return len(b), nil
}

// download 下載新版 exe 到 dest，並驗證大小、exe 格式與 SHA-256。
func (a *App) download(info *VersionInfo, dest string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pinnedDownloadURL(ctx, info.DownloadURL), nil)
	if err != nil {
		return err
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	hash := sha256.New()
	progress := &progressWriter{ctx: a.ctx, total: res.ContentLength}
	_, err = io.Copy(io.MultiWriter(f, hash, progress), res.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(dest)
		return err
	}
	if err := verifyDownload(dest, hash.Sum(nil), info.SHA256); err != nil {
		os.Remove(dest)
		return err
	}
	return nil
}

func verifyDownload(path string, sum []byte, expected string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	head := make([]byte, 2)
	if _, err := io.ReadFull(f, head); err != nil || info.Size() < 1<<20 || !bytes.Equal(head, []byte("MZ")) {
		return errors.New("downloaded file is not a valid program")
	}
	if expected != "" && !strings.EqualFold(hex.EncodeToString(sum), expected) {
		return errors.New("checksum mismatch (the update may still be publishing, please retry later)")
	}
	return nil
}

// ApplyUpdate 下載新版並替換目前的 exe，成功後重新啟動成新版並結束目前程式。
// 前端須先確認所有未存檔分頁。
func (a *App) ApplyUpdate() error {
	check, err := a.CheckForUpdate()
	if err != nil {
		return err
	}
	if !check.Available {
		return errors.New("already up to date")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}

	// 優先下載到 exe 旁（同一磁碟才能直接改名替換）；沒有寫入權限時改用暫存資料夾
	newFile := exe + ".new"
	if f, err := os.Create(newFile); err == nil {
		f.Close()
	} else {
		dir := filepath.Join(os.TempDir(), productID+"-update")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		newFile = filepath.Join(dir, productID+"-"+check.Latest.Version+".exe")
	}
	if err := a.download(&check.Latest, newFile); err != nil {
		return err
	}

	// Windows 允許把執行中的 exe 改名：舊檔改名為 .old，新檔放到原位置
	old := exe + ".old"
	os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return a.applyElevated(exe, newFile)
		}
		return err
	}
	if err := os.Rename(newFile, exe); err != nil {
		os.Rename(old, exe)
		return err
	}
	cmd := exec.Command(exe, fmt.Sprintf("--wait-pid=%d", os.Getpid()), "--updated")
	if err := cmd.Start(); err != nil {
		return err
	}
	a.Quit()
	return nil
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

// prepareAfterUpdate 在 wails 啟動前執行：等待舊版結束（避免單一執行個體鎖把自己轉交給舊版），並清除 .old。
func prepareAfterUpdate() {
	for _, arg := range os.Args[1:] {
		if pid, ok := strings.CutPrefix(arg, "--wait-pid="); ok {
			if n, err := strconv.Atoi(pid); err == nil {
				if h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(n)); err == nil {
					windows.WaitForSingleObject(h, 15000)
					windows.CloseHandle(h)
				}
			}
		}
	}
	if exe, err := os.Executable(); err == nil {
		go func() {
			for i := 0; i < 20; i++ {
				if err := os.Remove(exe + ".old"); err == nil || errors.Is(err, os.ErrNotExist) {
					break
				}
				time.Sleep(time.Second)
			}
			os.Remove(exe + ".new")
		}()
	}
}
