# add-import 任務清單

- [x] 1. Go：讀取檔案為 base64、計算輸出 .md 路徑與圖片資料夾（避免覆蓋既有檔案）、寫入時自動建立資料夾、開啟對話框新增「所有支援的文件」
- [x] 2. importer.js：Word（mammoth → HTML → turndown，圖片另存）與 HTML 轉換
- [x] 3. importer.js：Excel / CSV 轉表格（SheetJS）、PowerPoint 轉投影片大綱（JSZip 解析 XML）
- [x] 4. importer.js：PDF 文字抽取（pdf.js，只取文字、關閉 eval），依字體大小推斷標題
- [x] 5. main.js：開檔 / 拖放 / 命令列遇到可轉換格式時自動轉換並開新分頁；錯誤處理；中英文字串
- [x] 6. 建置並以測試版驗收（用 Word / Excel / PowerPoint 產生真實測試檔）

## 驗收條件

- 情境：開啟含標題、清單、表格、圖片的 .docx，新分頁顯示對應的 Markdown，預覽中圖片正常顯示，圖片存在「原檔名_images」資料夾
- 情境：開啟有兩個工作表的 .xlsx，轉成兩個標題與兩個表格
- 情境：開啟 .pptx，每張投影片成為一個標題，條列文字保留層級
- 情境：開啟文字型 PDF，得到可閱讀的段落文字，大字標題轉成 Markdown 標題
- 情境：開啟 .html 與 .csv 能轉成對應 Markdown
- 情境：轉換後分頁名稱為「原檔名.md」且標示未存檔；按 Ctrl+S 直接存到原檔旁
- 情境：同資料夾已有同名 .md 時，建議檔名自動加編號，不會覆蓋
- 情境：開啟 .doc（舊版）顯示「不支援」訊息
- 情境：轉換過程不需要網路
