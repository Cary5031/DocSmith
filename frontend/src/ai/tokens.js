// Token 估算與模型 context 大小。
// 沒有通用的本機 tokenizer（各家切法不同），所以用字元數估算，
// 再用服務實際回報的 usage 校正係數，越用越準。

// 常見模型的 context 大小；比對時用小寫、取最長的相符前綴
const CONTEXT_SIZES = [
  ['gpt-5', 400000],
  ['gpt-4.1', 1047576],
  ['gpt-4o', 128000],
  ['o3', 200000],
  ['o4', 200000],
  ['claude-sonnet', 200000],
  ['claude-opus', 200000],
  ['claude-haiku', 200000],
  ['claude-3', 200000],
  ['gemini-3', 1048576],
  ['gemini-2', 1048576],
  ['gemini-1.5', 1048576],
  ['deepseek-reasoner', 128000],
  ['deepseek-chat', 128000],
  ['deepseek', 128000],
  ['qwen', 128000],
  ['llama', 128000],
  ['mistral', 128000],
];

export const DEFAULT_CONTEXT = 128000;

export function contextSizeFor(model) {
  const name = (model ?? '').toLowerCase();
  let best = null;
  for (const [prefix, size] of CONTEXT_SIZES) {
    if (name.includes(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, size];
  }
  return best ? best[1] : DEFAULT_CONTEXT;
}

// 中日韓文字大約 1 token ≈ 1.5 字，其餘（英數、符號、空白）大約 1 token ≈ 4 字元
const CJK = /[⺀-⻿　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

let factor = 1; // 依實際 usage 校正的係數
let calibrated = false;

export function rawEstimate(text) {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) if (CJK.test(ch)) cjk++;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}

export function estimateTokens(text) {
  return Math.ceil(rawEstimate(text) * factor);
}

// 一次請求的訊息陣列（{ role, content }）加上每則訊息的固定成本
export function estimateMessages(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0) + 3;
}

// 用服務回報的 prompt tokens 校正：只在估算誤差合理時採用，避免被異常值帶壞
export function calibrate(actualPromptTokens, messages) {
  const raw = messages.reduce((sum, m) => sum + rawEstimate(m.content) + 4, 0) + 3;
  if (!actualPromptTokens || raw <= 0) return;
  const ratio = actualPromptTokens / raw;
  if (ratio < 0.4 || ratio > 3) return;
  factor = calibrated ? factor * 0.7 + ratio * 0.3 : ratio;
  calibrated = true;
}

export function isCalibrated() {
  return calibrated;
}

export function resetCalibration() {
  factor = 1;
  calibrated = false;
}
