# add-ai-thinking 任務清單

- [x] 1. ai.go：設定新增 `thinking` 欄位（儲存 / 讀取 / 預設「不指定」），resolveRequest 帶出
- [x] 2. aichat.go：依供應商組出思考參數（reasoning_effort / DeepSeek thinking）
- [x] 3. aichat.go：串流解析 `reasoning_content` 與 `reasoning`，以 `ai:think` 事件送到前端
- [x] 4. settings.js：思考模式下拉與一行說明
- [x] 5. panel.js：可收合的「思考過程」區塊（串流中展開、答案出現後收合）
- [x] 6. 中英文字串與樣式
- [x] 7. 建置並以本機模擬服務驗收（含 DeepSeek 格式、關閉、預設不送參數）

## 驗收條件

- 情境：AI 設定裡把思考模式選「高」並儲存，重開設定畫面仍顯示「高」
- 情境：思考模式是「預設」時，送出的請求裡完全沒有 `reasoning_effort` 或 `thinking` 欄位
- 情境：供應商是 OpenAI / Gemini / 自訂模型且選「低」，請求帶 `reasoning_effort: "low"`
- 情境：供應商是 OpenAI / Gemini / 自訂模型且選「關閉」，請求帶 `reasoning_effort: "none"`
- 情境：供應商是 DeepSeek 且選「關閉」，請求帶 `thinking: { type: "disabled" }` 且不帶 reasoning_effort
- 情境：供應商是 DeepSeek 且選「高」，請求帶 `thinking: { type: "enabled" }` 與 `reasoning_effort: "high"`
- 情境：服務回傳 `reasoning_content` 時，面板出現「思考過程」區塊，可以展開與收合，答案照樣逐字顯示
- 情境：服務因為不支援思考參數回 400 時，面板顯示服務的錯誤訊息，程式不會卡住
