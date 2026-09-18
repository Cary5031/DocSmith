# add-mermaid（新功能）

## 為什麼做

公司文件常用流程圖、循序圖、甘特圖。Mermaid 讓這些圖以純文字寫在 Markdown 裡，但目前預覽只會顯示原始碼。

## 要改什麼

- 預覽中 ```` ```mermaid ```` 程式碼區塊改為繪製成圖表（流程圖、循序圖、類別圖、狀態圖、甘特圖、圓餅圖等 Mermaid 支援的類型）
- 圖表語法錯誤時，在該位置顯示錯誤訊息（不影響其他內容）
- Mermaid 函式庫內嵌進 exe，離線可用；延遲載入，沒用到圖表時不拖慢啟動
- 相同內容的圖表快取結果，打字時不會每次重畫、不閃爍
- 圖表以 strict 安全等級繪製（不執行圖表內的腳本 / 點擊事件）

## 影響範圍

- `frontend/package.json`（新增 mermaid）
- `frontend/src/preview.js`（mermaid 區塊輸出、非同步繪製、快取）
- `frontend/src/main.js`（繪製完成後更新同步捲動錨點）
- `frontend/src/style.css`（圖表置中、錯誤樣式）
- `frontend/src/i18n.js`（錯誤訊息字串）
