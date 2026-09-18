# docsmith-bootstrap 任務清單

- [x] 1. 複製專案到新目錄（排除 .git、建置產物、舊手冊），建立新 git repo
- [x] 2. 新增 names.go 集中產品名稱與 repo；Go 端改名（module、設定資料夾、ProgID、單一執行個體 ID、更新網址）
- [x] 3. 前端與設定檔改名（視窗標題、介面字串、wails.json、publish.ps1、version.json 0.1.0）
- [x] 4. 產生「匠」字圖示
- [x] 5. 建置並驗收（與 MarkDown Builder 同時執行、設定分開存放）

## 驗收條件

- 情境：`build\bin\DocSmith.exe` 可以執行，視窗標題為「未命名 - DocSmith」
- 情境：設定存在 `%APPDATA%\DocSmith\`，不會動到 MarkDown Builder 的設定
- 情境：MarkDown Builder 開著時仍可開啟 DocSmith（兩者的單一執行個體互不干擾）
- 情境：工作列與 exe 圖示為「匠」字
- 情境：原有功能（編輯、預覽、分頁、匯出、轉換）照常運作
