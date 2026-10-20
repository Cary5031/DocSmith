# 在 Linux / Omarchy 上使用 DocSmith

Windows 版是單一的 `DocSmith.exe`，使用系統內建的 WebView2。Linux 版用同一套原始碼編譯，視窗由 GTK 3 與 WebKitGTK 4.1 繪製，執行時需要這兩個系統套件。介面、分頁、Markdown、PDF、電子書與 AI 助手和 Windows 版相同。

已在 Omarchy（Hyprland）上用 `wails build -tags webkit2_41` 編成執行檔，並打開主視窗確認可以啟動。

## 和 Windows 版的差異

| 項目 | Windows | Linux |
| --- | --- | --- |
| 發佈形式 | 單一 `DocSmith.exe`，不需其他執行階段 | 執行檔加上系統的 GTK 3、WebKitGTK 4.1 |
| 設定目錄 | `%APPDATA%\DocSmith\` | `$XDG_CONFIG_HOME/DocSmith`，未設定時為 `~/.config/DocSmith/` |
| API 金鑰與對話加密 | 目前 Windows 帳號的 DPAPI | `secret.key`（32 位元組，權限 `0600`）。金鑰在設定目錄，不在專案裡 |
| 對話備援 | `%APPDATA%\DocSmith\chats-backup\` | `~/.config/DocSmith/chats-backup/`，一樣是明文 |
| 沒有開啟資料夾時的對話 | `%APPDATA%\DocSmith\chats\` | `~/.config/DocSmith/chats/` |
| 檔案關聯 | 寫入 `HKCU`，並打開「選擇開啟方式」 | 寫入 `~/.local/share/applications/DocSmith.desktop`。使用者在程式內同意後，以 `xdg-mime` 把 Markdown 的預設程式設為 DocSmith |
| 用系統程式開啟檔案 | `ShellExecute` | `xdg-open` |
| 匯出 PDF | Microsoft Edge 無頭模式 | 依序尋找 Chrome、Chromium、Edge、Brave |
| 標題列深色 | DWM 沉浸式深色模式 | 無框視窗，只切換 WebKit 的深淺色 |
| 單一執行個體 | 具名 mutex 與隱藏訊息視窗 | `~/.config/DocSmith/instance.sock` |
| 公司 AI 政策 | `HKLM\SOFTWARE\Policies\DocSmith` | 沒有對應機制，AI 維持可用 |
| 自動更新 | 下載並替換 `DocSmith.exe` | 不執行。更新檔是 Windows 執行檔，套用會蓋掉 Linux 執行檔 |

複製專案資料夾不會帶走 `secret.key`，所以 `.DocSmith/chats/` 裡的加密對話在別台機器上解不開。明文備援、匯出與備份 JSON 不受影響。`secret.key` 遺失後，已存的金鑰與加密對話也解不開，備援仍可讀。

## 在 Omarchy 上編譯

需要 Go 1.25 以上（`go.mod` 的版本）、Node.js 20.19 以上、GCC、pkg-config、GTK 3、WebKitGTK 4.1，以及與 `go.mod` 相同主版本的 wails v2。

```bash
sudo pacman -S --needed gtk3 webkit2gtk-4.1 pkgconf gcc
go install github.com/wailsapp/wails/v2/cmd/wails@v2.16.0
wails build -tags webkit2_41
```

`-tags webkit2_41` 不能省。不帶這個標籤時，wails 會尋找 `webkit2gtk-4.0`。Omarchy 目前提供的是 `webkit2gtk-4.1`，`wails doctor` 也因此把 libwebkit 報成未安裝；套件其實在，用上面的標籤即可編譯。

其他發行版只要 `pkg-config` 找得到 `gtk+-3.0` 與 `webkit2gtk-4.1`，同一道指令就能用。

編譯結果是 `build/bin/DocSmith`。可以放到 `~/.local/bin/`：

```bash
install -m 755 build/bin/DocSmith ~/.local/bin/DocSmith
```

第一次啟動會寫入這兩個檔案，之後從應用程式啟動器就能找到「DocSmith／文匠」：

- `~/.local/share/applications/DocSmith.desktop`
- `~/.local/share/icons/hicolor/256x256/apps/docsmith.png`

桌面檔的 `Exec` 指向實際執行的那份程式。把執行檔換地方之後，再開一次就會改寫。

Hyprland 會依平常的視窗規則排列這個無框視窗。WebKit 啟動時可能印出 `Overriding existing handler for signal 10`，不影響使用。

## 匯出 PDF

Linux 沒有內建 Edge。匯出 PDF 時會使用路徑上第一個找到的 Chromium 系瀏覽器：`google-chrome-stable`、`google-chrome`、`chromium`、`chromium-browser`、`microsoft-edge`、`microsoft-edge-stable`、`brave`、`brave-browser`。都沒有時，匯出 PDF 會失敗，匯出 Word 不受影響。

## 開發時的平台切分

共用邏輯留在原本的檔案。只有該平台能編譯的函式拆出去：

```text
assoc.go / export.go / updater.go / …   共用流程
*_windows.go                             DPAPI、登錄檔、Edge、UAC 更新
*_linux.go、*_other.go                   xdg、本機金鑰、WebKit 主題、Unix socket
titlebar_theme.go                        兩邊都要的標題列主題
```

Windows 建置不定義 `webkit2_41`，仍使用 WebView2。Linux 測試裡，以 `%APPDATA%`、磁碟機代號、`NUL`、junction 為前提的測試會失敗；聊天加密的往返、清單與備援改讀在 Linux 上可以通過。

## 更新已安裝的 Linux 版

程式內的「立即更新」在 Linux 上會拒絕執行，並說明自動更新只適用 Windows 執行檔。要更新就重新編譯，再覆蓋 `~/.local/bin/DocSmith`。
