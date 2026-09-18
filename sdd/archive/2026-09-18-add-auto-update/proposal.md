# add-auto-update（新功能）

## 為什麼做

程式散布到同事電腦後，新版推送到 GitHub 時大家不會知道，也不會自己去下載。需要程式自動檢查並協助更新。

## 要改什麼

- **版本資訊**：`version.json`（版本號、日期、下載網址、SHA-256、中英文更新說明）在編譯時內嵌進 exe 作為目前版本；GitHub 上的 `version.json` 為最新版本
- **自動檢查**：啟動數秒後檢查一次，之後每 6 小時檢查；**網路離線或連不上 GitHub 時靜默略過**，不顯示任何訊息
  - 支援 Windows 的 Proxy 設定；HTTPS 憑證使用系統憑證庫
- **新版本提示**：右下角出現卡片「有新版本 vX.Y.Z」與更新說明，按鈕「立即更新」/「稍後」
- **更新流程**（按「立即更新」）：
  1. 有未存檔的分頁時逐一詢問（同關閉視窗）；取消則不更新
  2. 從 GitHub 下載新版 exe，卡片顯示下載進度
  3. 驗證檔案（大小、exe 格式、SHA-256）
  4. 將執行中的舊 exe 改名為 `.old`，新 exe 放到原位置，啟動新版並關閉舊版
  5. 新版啟動時刪除 `.old`，並提示「已更新到 vX.Y.Z」
  - exe 所在資料夾沒有寫入權限時（例如 Program Files），改用系統管理員權限完成替換（會出現 UAC 確認）
  - 下載或驗證失敗時卡片顯示錯誤，可重試；原本的程式不受影響
- `publish.ps1` 建置後自動計算 exe 的 SHA-256 寫入 `version.json`

## 影響範圍

- `updater.go`（新增：內嵌版本、檢查更新、下載驗證、替換並重新啟動）
- `main.go`（啟動時等待舊版結束、清除 `.old`）
- `frontend/index.html`、`frontend/src/main.js`、`frontend/src/style.css`、`frontend/src/i18n.js`（更新卡片）
- `publish.ps1`（寫入 SHA-256）
- `version.json`（新增 sha256 欄位）
