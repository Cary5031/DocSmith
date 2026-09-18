# add-import（新功能）

## 為什麼做

公司既有文件大多是 Word、Excel、PowerPoint、PDF。要改成 Markdown 時，目前只能手動複製貼上再重新排版。

## 要改什麼

- 開啟（Ctrl+O）、拖放、命令列帶入下列檔案時，自動轉成 Markdown 並開成新分頁：
  | 格式 | 轉換內容 |
  | --- | --- |
  | Word（.docx） | 標題、段落、粗體 / 斜體、清單、表格、連結、圖片（另存到圖片資料夾） |
  | Excel（.xlsx / .xls / .ods） | 每個工作表一個標題 + 表格 |
  | PowerPoint（.pptx） | 每張投影片一個標題，內文依層級轉為清單，投影片中的表格轉為表格 |
  | PDF（.pdf） | 文字內容，依字體大小推斷標題、依間距分段（不保留版面與圖片） |
  | HTML（.html / .htm） | 標題、段落、清單、表格、連結、圖片 |
  | CSV（.csv） | 表格 |
- 轉換結果放在新分頁，預設檔名為「原檔名.md」（與原檔同資料夾；若已存在則加上編號），標示為未存檔，按 Ctrl+S 即存到該位置
- Word 內嵌圖片存到「原檔名_images」資料夾，Markdown 以相對路徑引用，預覽可直接看到
- 狀態列顯示「已從 xxx 轉換」
- 不支援的格式（舊版 .doc、.ppt 等）或轉換失敗時顯示錯誤訊息
- 開啟對話框的檔案類型新增「所有支援的文件」

## 影響範圍

- `frontend/package.json`（新增 mammoth、turndown、@joplin/turndown-plugin-gfm、xlsx、pdfjs-dist、jszip）
- `frontend/vendor/xlsx-0.20.3.tgz`（SheetJS 官方套件，npm 上的舊版有已知漏洞）
- `frontend/src/importer.js`（新增：各格式轉 Markdown）
- `frontend/src/main.js`（開檔流程判斷格式並轉換）
- `frontend/src/i18n.js`
- `app.go`（讀取二進位檔、建議輸出路徑、開啟對話框篩選）
- `export.go`（寫入二進位檔時自動建立資料夾）
