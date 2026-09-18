package main

// 產品名稱與發布位置集中在這裡；日後改名只需修改這個檔案與前端的 appName。
const (
	productName  = "DocSmith"                             // 顯示名稱
	productID    = "DocSmith"                             // 設定資料夾、登錄機碼、檔案關聯使用的識別名稱
	exeName      = "DocSmith.exe"                         // build/bin 中的執行檔名稱（自動更新下載的檔案）
	githubRepo   = "Cary5031/DocSmith"                    // 自動更新的 GitHub repo（尚未建立時檢查會靜默失敗）
	instanceLock = "7c2d4b1e-9a3f-4e6b-8d15-docsmith-app" // 單一執行個體鎖（與 MarkDown Builder 不同）
)
