# add-sidebar（新功能）

## 為什麼做

處理一整個專案資料夾（多份文件、程式碼）時，需要能直接瀏覽資料夾結構；閱讀長文件時，需要大綱快速跳到指定章節。

## 要改什麼

- 視窗左側新增**活動列**（圖示按鈕）與可調整寬度的**側欄**；點同一個圖示可收合側欄。側欄寬度與開啟狀態會記住
- **檔案總管**：
  - 「開啟資料夾」選擇一個資料夾，以樹狀顯示（資料夾在前、依名稱排序），展開時才讀取子資料夾
  - 點檔案即開成分頁（依類型用編輯器、PDF 或電子書閱讀器開啟）；目前分頁對應的檔案會標示
  - 依檔案類型顯示不同圖示；隱藏 `.git`、`node_modules` 等資料夾
  - 重新整理、全部收合、關閉資料夾；存檔後自動重新整理
  - 記住上次開啟的資料夾與展開狀態
- **大綱**：依目前分頁顯示
  - Markdown：標題階層，並標示游標所在的章節
  - 程式碼：函式 / 類別（JavaScript、TypeScript、Python、Go、C#、Java、PowerShell 等常見寫法）
  - PDF：PDF 內建的書籤目錄
  - 電子書：書本目錄
  - 點項目跳到該處；內容修改後自動更新

## 影響範圍

- `files.go`（新增：選擇資料夾、列出資料夾內容）
- `frontend/index.html`（版面：活動列、側欄、文件區）
- `frontend/src/sidebar.js`（新增：活動列、側欄、檔案總管、大綱）
- `frontend/src/main.js`（分頁切換 / 內容變動事件、存檔後通知）
- `frontend/src/viewers/pdf.js`、`frontend/src/viewers/ebook.js`（提供大綱）
- `frontend/src/style.css`、`frontend/src/i18n.js`
