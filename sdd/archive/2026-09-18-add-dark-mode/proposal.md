# add-dark-mode（新功能）

## 為什麼做

長時間閱讀程式碼、電子書或在昏暗環境使用時，白色介面刺眼。需要深色模式，並能跟隨 Windows 的系統設定。

## 要改什麼

- 工具列新增主題按鈕：跟隨系統 → 淺色 → 深色 循環切換，設定會記住
- 「跟隨系統」時，Windows 切換淺色 / 深色會即時跟著變
- 深色主題涵蓋：工具列、分頁列、編輯區（含語法上色、游標、選取、搜尋面板）、Markdown 預覽（表格、程式碼區塊、引用、錯誤訊息）、對話框、更新卡片、PDF 閱讀器外框、電子書閱讀器外框、視窗標題列
- Mermaid 圖表在深色主題下使用深色配色
- 匯出 PDF / Word **一律使用淺色**（不受介面主題影響）
- PDF 頁面維持原樣（白底）；電子書仍使用閱讀器自己的白 / 米 / 深色主題

## 影響範圍

- `frontend/src/style.css`（顏色改為 CSS 變數、深色調色盤、程式碼區塊上色）
- `frontend/src/editor.js`（語法上色改用變數、游標與選取顏色）
- `frontend/src/preview.js`（Mermaid 依主題繪製與快取）
- `frontend/src/export.js`（匯出固定淺色）
- `frontend/src/main.js`（主題按鈕、跟隨系統、標題列）
- `frontend/src/i18n.js`、`app.go`（設定新增 theme）
