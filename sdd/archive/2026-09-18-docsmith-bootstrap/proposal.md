# docsmith-bootstrap（重構）

## 為什麼做

MarkDown Builder 將加入文字檔、程式檔、PDF、電子書、AI 等功能，已超出 Markdown 編輯器的範圍。另立獨立專案「DocSmith（文匠）」進行，不影響已發布的 MarkDown Builder。

## 要改什麼

- 從 MarkDown Builder v1.7.3 複製程式碼到 `D:\WorkSpace\DocSmith`，建立獨立的 git repo（只在本機，不推送）
- 名稱改為 DocSmith / 文匠：exe 檔名、視窗標題、設定資料夾（`%APPDATA%\DocSmith`）、檔案關聯 ProgID、單一執行個體 ID、Go module 名稱
- 名稱與 GitHub repo 集中成常數，日後改名只需改一處
- 版本號從 0.1.0 開始；自動更新改指向未來的 `Cary5031/DocSmith` repo（repo 不存在時檢查會靜默失敗，不影響使用）
- 新圖示：「匠」字
- 與 MarkDown Builder 可同時安裝、同時執行，互不干擾

## 影響範圍

- `go.mod`、`wails.json`、`main.go`、`app.go`、`assoc.go`、`updater.go`、`export.go`、`version.json`、`publish.ps1`、`README.md`
- 新增 `names.go`（產品名稱、GitHub repo 常數）
- `frontend/index.html`、`frontend/src/i18n.js`、`frontend/package.json`
- `build/appicon.png`、`build/windows/icon.ico`
