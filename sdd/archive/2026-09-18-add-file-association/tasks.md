# add-file-association 任務清單

- [x] 1. assoc.go：HKCU 註冊 ProgID、OpenWithProgids、Applications、Capabilities / RegisteredApplications，變更時通知檔案總管
- [x] 2. assoc.go：檢查 .md 預設程式是否為本程式；呼叫 Windows「選擇開啟方式」視窗
- [x] 3. main.go：啟動時註冊；單一執行個體，第二個執行個體的檔案轉交給既有視窗並帶到最前面
- [x] 4. 前端：首次詢問設為預設（設定 / 以後再說 / 不要再問）、狀態列「設為預設程式」連結、接收轉交檔案；設定整份保存；中英文字串
- [x] 5. 建置並以測試版驗收（檢查登錄檔、第二個執行個體、選擇開啟方式視窗）

## 驗收條件

- 情境：啟動程式後，HKCU\Software\Classes 下有 MarkDownBuilder.Markdown，開啟指令指向目前 exe 路徑
- 情境：.md 的 OpenWithProgids 包含本程式；「設定 → 預設應用程式」清單可找到 MarkDown Builder
- 情境：目前不是預設程式時，第一次啟動詢問是否設為預設；選「不要再問」後重開不再詢問
- 情境：選「設定」或點狀態列連結，出現 Windows「選擇開啟方式」視窗
- 情境：已是預設程式時，不詢問、狀態列不顯示連結
- 情境：程式開著時，再以命令列（等同雙擊）開另一個 .md，檔案在原視窗開成新分頁，不會出現第二個視窗
