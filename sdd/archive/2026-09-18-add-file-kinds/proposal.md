# add-file-kinds（新功能）

## 為什麼做

DocSmith 要能開啟各種文字類檔案（純文字、記錄檔、設定檔、程式碼），而不只是 Markdown。這也是之後 PDF、電子書、AI 等功能的基礎：每個分頁需要知道自己是哪一種文件。

## 要改什麼

- 分頁新增「類型」：Markdown / 文字（含程式碼）/（之後的 PDF、電子書）
- **任何文字檔都能開啟**：依副檔名自動套用語法上色（JavaScript、TypeScript、Python、Go、C#、Java、C/C++、SQL、JSON、YAML、XML、HTML、CSS、PowerShell、Shell 等 CodeMirror 支援的語言）
  - 程式碼不自動換行；純文字（.txt、.log 等）自動換行
  - 非 Markdown 的分頁：隱藏預覽、停用 Markdown 格式按鈕與 PDF / Word 匯出、檢視模式固定為只編輯
  - 狀態列顯示檔案類型（例如「Python」「純文字」）
- **編碼**：新增 UTF-16（LE / BE，有 BOM）的讀取與原樣存回；仍支援 UTF-8、Big5
- **二進位檔**（圖片、exe 等）不以文字開啟，顯示「不是文字檔」提示
- HTML、CSV 改為以原始碼開啟（可編輯），工具列提供「轉為 Markdown」按鈕（沿用原本的轉換功能）；Word / Excel / PowerPoint 仍自動轉換
- 開啟對話框的「所有支援的文件」涵蓋上述格式，拖放不再限制副檔名

## 影響範圍

- `frontend/src/kinds.js`（新增：依副檔名判斷文件類型）
- `frontend/src/editor.js`（每個分頁依類型與語言建立編輯狀態）
- `frontend/src/main.js`（分頁類型、版面切換、工具列啟用狀態、轉為 Markdown）
- `frontend/src/importer.js`（可轉換格式清單調整）
- `frontend/src/style.css`、`frontend/src/i18n.js`
- `app.go`（UTF-16 讀寫、二進位檔偵測、開啟對話框篩選）
