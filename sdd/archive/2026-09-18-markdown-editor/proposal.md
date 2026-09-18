# markdown-editor（新功能）

## 為什麼做

公司近期大量文件改用 Markdown 撰寫，但同仁手上沒有一套能「正確編輯＋正確瀏覽」Markdown 的工具（記事本看不到排版、線上工具有資料外流疑慮）。需要一支：

- 離線可用、不需安裝，**單一 .exe** 就能執行
- 操作簡單，打開檔案就能看、就能改
- 介面可切換 **English / 繁體中文**

## 要改什麼

從零新增一支 Windows 桌面 Markdown 編輯器，功能如下：

- **編輯**：Markdown 原始碼編輯區，有語法上色、行號、自動換行
- **即時預覽**：邊打邊看排版結果，支援 GFM（表格、任務清單 `- [ ]`、刪除線、自動連結）與程式碼區塊語法高亮
- **檢視模式**：「只編輯 / 左右分割 / 只預覽」三種切換；分割模式兩邊同步捲動
- **檔案操作**：新增、開啟、儲存、另存新檔（UTF-8）；可把 .md 拖進視窗開啟；可用命令列參數開檔（讓使用者能設定「用此程式開啟 .md」）
- **未存檔保護**：標題列顯示 `*`；關閉視窗或開新檔前若有未存變更，詢問是否儲存
- **預覽正確顯示**：相對路徑圖片（如 `![](images/a.png)`）能正常顯示；點連結用系統預設瀏覽器開啟；文件內的 HTML 會經過過濾，避免惡意腳本
- **格式工具列**：粗體、斜體、刪除線、標題、項目/編號/任務清單、引用、行內程式碼/程式碼區塊、連結、圖片、表格、分隔線，並配常用快捷鍵（Ctrl+B / Ctrl+I / Ctrl+S / Ctrl+O / Ctrl+N 等）
- **介面語言切換**：English / 繁體中文，即時切換並記住選擇（首次啟動依系統語言決定）

**刻意不做**（避免過度設計，之後有需要再另開提案）：匯出 PDF/Word、Mermaid 圖表、數學公式、多分頁、自動更新、檔案關聯自動註冊。

## 技術選型

- **外殼**：Go 1.23 + **Wails v2**（使用 Windows 內建的 WebView2 / Edge 核心），編譯後為真正的單一 exe（約 10–15 MB），不需解壓、秒開
  - 評估過 .NET 9（exe 60–70 MB）、Electron（portable 版每次啟動要解壓、約 100 MB、易被防毒擋）、Tauri（需裝數 GB Rust 工具鏈），綜合大小、啟動速度與建置成本選 Wails
- **介面**：HTML/CSS/JS，以 Vite 打包後用 `go:embed` 內嵌進 exe，完全離線：
  - CodeMirror 6（編輯器）、markdown-it + task-lists 外掛（解析）、highlight.js（程式碼高亮）、DOMPurify（HTML 過濾）
- **發佈**：`wails build` 輸出單一 `MarkDownBuilder.exe`
- **同事電腦需求**：WebView2 Runtime（Win11 內建、Win10 有更新者皆有；若缺，程式會提示下載）

## 影響範圍

全部是新增檔案：

- `main.go`（視窗設定、內嵌資源、拖放、關閉攔截）
- `app.go`（給前端呼叫的檔案操作：開啟 / 儲存 / 另存、啟動參數、設定讀寫）
- `dochandler.go`（提供預覽中相對路徑圖片的讀取）
- `go.mod`、`wails.json`
- `frontend/`：`index.html`、`src/main.js`、`src/editor.js`、`src/preview.js`、`src/i18n.js`、`src/style.css`、`package.json`
- `build/`（Wails 產生的圖示、Windows manifest）
- `publish.ps1`（一鍵產生單一 exe）
- `README.md`（建置與使用說明）
