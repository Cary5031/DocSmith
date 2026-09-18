# add-ai-thinking（新功能）

## 為什麼做

AI 設定裡只能選服務、金鑰與模型，沒有「思考模式」。現在的推理模型（OpenAI gpt-5 系列、Gemini 3、DeepSeek 等）都可以指定要想多久：想得少→快又省，想得多→答得準。沒有這個設定，就只能用服務端的預設值，也無法在需要時關掉思考來加快回應。

另外，思考模式打開時，服務會先回傳一段「思考內容」（`reasoning_content`），目前程式完全忽略它，使用者會看到很久沒有任何反應。

## 要改什麼

- AI 設定新增**思考模式**下拉：`預設（不指定）` / `關閉` / `低` / `中` / `高`，每個供應商各自記住
  - 預設值是「預設（不指定）」，也就是**請求裡不帶任何思考參數**，確保公司自架或較舊的服務不會因為多了參數而回 400
- 送出對話時依供應商組出對應參數：
  | 供應商 | 關閉 | 低 / 中 / 高 |
  | --- | --- | --- |
  | OpenAI、Gemini、自訂模型 | `reasoning_effort: "none"` | `reasoning_effort: "low" / "medium" / "high"` |
  | DeepSeek | `thinking: { type: "disabled" }` | `thinking: { type: "enabled" }`，低 / 高再加 `reasoning_effort: "low" / "high"` |
- 設定畫面上用一行小字說明：這個選項要服務與模型支援；不支援時服務會回錯誤，改回「預設」即可
- AI 面板顯示**思考過程**：串流中把 `reasoning_content`（或 `reasoning`）收進一個可收合的區塊，答案開始出現後自動收合，點一下可展開

## 影響範圍

- `ai.go`（設定多一個 `thinking` 欄位、儲存與讀取、預設值）
- `aichat.go`（依供應商組思考參數；解析 `reasoning_content` / `reasoning`，以 `ai:think` 事件送到前端）
- `frontend/src/ai/settings.js`（思考模式下拉與說明）
- `frontend/src/ai/panel.js`（思考過程區塊）
- `frontend/src/i18n.js`、`frontend/src/style.css`

## 參考

- OpenAI：<https://developers.openai.com/api/docs/guides/reasoning>
- Gemini OpenAI 相容：<https://ai.google.dev/gemini-api/docs/openai>
- DeepSeek 思考模式：<https://api-docs.deepseek.com/guides/thinking_mode/>
