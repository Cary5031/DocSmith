# add-export（新功能）

## 為什麼做

Markdown 文件要交給客戶、主管或沒有 Markdown 工具的同事時，需要 PDF 或 Word 格式。

## 要改什麼

- 工具列新增「匯出 PDF」與「匯出 Word」按鈕，選擇存檔位置後匯出目前分頁的文件
- **PDF**：以 Windows 內建的 Microsoft Edge 無頭模式列印，版面與預覽一致
  - 文字為向量（可選取、可搜尋），中文、程式碼上色、表格、圖片、Mermaid 圖表、數學公式都保留
  - A4、適當邊界；避免程式碼區塊與表格列被硬切
- **Word（.docx）**：產生原生 Word 格式
  - 標題（對應 Word 標題樣式，可產生目錄）、粗體 / 斜體 / 刪除線 / 行內程式碼、超連結、項目 / 編號 / 任務清單（含巢狀）、引用、程式碼區塊（等寬字、灰底）、表格、分隔線、圖片
  - Mermaid 圖表與數學公式轉為高解析度圖片嵌入
  - 中文字型使用微軟正黑體
- 匯出完成後詢問是否立即開啟檔案
- 匯出失敗（例如找不到 Edge、檔案被 Word 鎖定）時顯示錯誤訊息

## 影響範圍

- `frontend/package.json`（新增 docx、html-to-image）
- `frontend/src/export.js`（新增：組出獨立 HTML、DOM 轉 docx、圖表 / 公式轉圖片）
- `frontend/src/main.js`（工具列按鈕、匯出流程）
- `frontend/src/i18n.js`、`frontend/src/style.css`
- `export.go`（新增：另存對話框、呼叫 Edge 產生 PDF、寫入二進位檔、用預設程式開啟檔案）
