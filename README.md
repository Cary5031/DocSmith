# DocSmith（文匠）

閱讀、撰寫、AI 協作的文件工作台：Markdown、文字檔、程式檔、PDF、電子書，單一執行檔、離線可用，介面可切換繁體中文 / English。

> 由 MarkDown Builder v1.7.3 延伸而來的實驗專案（僅在本機開發，尚未發布）。

## 開發

需求：Go 1.23+、Node.js 20.19+、wails CLI（`go install github.com/wailsapp/wails/v2/cmd/wails@latest`）

```powershell
wails dev          # 開發模式
.\publish.ps1      # 產生 build\bin\DocSmith.exe
```

產品名稱與 GitHub repo 集中在 `names.go` 與 `frontend/src/i18n.js` 的 `appName`，改名只需修改這兩處。
