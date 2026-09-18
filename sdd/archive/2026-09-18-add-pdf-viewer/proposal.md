# add-pdf-viewer（新功能）

## 為什麼做

目前開啟 PDF 只會把文字轉成 Markdown，看不到原本的版面、圖片與表格。需要能直接閱讀原始 PDF，必要時再轉成 Markdown。

## 要改什麼

- 開啟 PDF 時以閱讀器顯示原始頁面（pdf.js 繪製，完全離線），每個 PDF 一個分頁
- 閱讀器工具列：
  - 縮圖側欄（點縮圖跳頁）
  - 上一頁 / 下一頁、頁碼輸入與總頁數
  - 縮小 / 放大、縮放選單（自動、符合頁寬、整頁、50%–300%）
  - 搜尋（輸入文字即時搜尋、上一個 / 下一個、高亮顯示所有結果、顯示結果數）
- 可選取、複製 PDF 中的文字；PDF 內的目錄連結可跳頁；外部連結用預設瀏覽器開啟
- 主工具列的「轉為 Markdown」可把目前 PDF 轉成 Markdown 新分頁（沿用既有轉換）
- 狀態列顯示「第 X / Y 頁」與縮放比例
- 快捷鍵：Ctrl+F 搜尋、Ctrl+加號 / 減號縮放、Ctrl+0 符合頁寬
- 安全：不執行 PDF 內的 JavaScript（pdf.js 使用已修補漏洞的版本）
- 大型 PDF 以分段讀取（HTTP Range），不必整份載入記憶體

## 影響範圍

- `frontend/src/viewers/pdf.js`（新增：PDF 閱讀器）
- `frontend/src/main.js`（註冊閱讀器、快捷鍵轉交給閱讀器）
- `frontend/src/style.css`、`frontend/src/i18n.js`
