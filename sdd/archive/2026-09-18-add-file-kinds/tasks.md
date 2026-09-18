# add-file-kinds 任務清單

- [x] 1. app.go：UTF-16 讀取與存回、二進位檔偵測、開啟對話框篩選清單
- [x] 2. kinds.js：依副檔名判斷 markdown / text / office / unsupported（預留 pdf、ebook）
- [x] 3. editor.js：依類型建立狀態（Markdown 才有格式快捷鍵與 Markdown 語法；程式碼依副檔名載入語言、不換行）
- [x] 4. main.js：分頁記錄類型；切換分頁時套用版面（非 Markdown 隱藏預覽、停用格式與匯出按鈕）；狀態列顯示語言
- [x] 5. main.js：HTML / CSV 以原始碼開啟 + 「轉為 Markdown」按鈕；拖放不限副檔名；中英文字串
- [x] 6. 建置並驗收

## 驗收條件

- 情境：開啟 .py / .go / .json / .sql 檔，有對應的語法上色、不自動換行，狀態列顯示語言名稱
- 情境：開啟 .txt / .log，自動換行、狀態列顯示「純文字」
- 情境：非 Markdown 分頁看不到預覽區，格式按鈕、匯出按鈕、檢視模式按鈕為停用狀態；切回 Markdown 分頁恢復
- 情境：開啟 UTF-16 的文字檔內容正確，存檔後仍是 UTF-16（含 BOM）
- 情境：拖入 .png / .exe，顯示「不是文字檔」提示，不開分頁
- 情境：開啟 .html 顯示原始碼；按「轉為 Markdown」產生新的 Markdown 分頁
- 情境：開啟 .docx 仍自動轉成 Markdown
- 情境：程式碼分頁按 Ctrl+B 不會插入 `**`
