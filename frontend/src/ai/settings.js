// AI 設定對話框：供應商、服務網址、API 金鑰、自訂表頭、模型清單、測試連線。
import { createElement, Eye, EyeOff, Trash2, Plus, RefreshCw, Zap } from 'lucide';
import { GetAIConfig, SaveAIConfig, ListAIModels, TestAIConnection } from '../../wailsjs/go/main/App';
import { t } from '../i18n.js';

const KEEP = '__docsmith_keep__'; // 與 Go 端一致：表示祕密欄位沒有變動
const PROVIDERS = [
  ['openai', 'OpenAI'],
  ['gemini', 'Gemini'],
  ['deepseek', 'DeepSeek'],
  ['custom', 'aiProviderCustom'],
];

let app = null;
let config = null; // GetAIConfig() 的結果
let drafts = {}; // provider → 草稿
let current = 'openai';
let root = null;
let ui = {};

export function initAISettings(appApi) {
  app = appApi;
}

// 錯誤代碼（Go 端以 CODE|詳細訊息 回傳）轉成看得懂的說明
export function aiErrorMessage(err) {
  const raw = String(err?.message ?? err ?? '');
  const [code, detail = ''] = raw.split('|');
  const known = {
    AI_DISABLED: 'aiDisabledByPolicy',
    AI_PROVIDER_NOT_ALLOWED: 'aiProviderNotAllowed',
    AI_NO_BASE_URL: 'aiNoBaseUrl',
    AI_UNAUTHORIZED: 'aiUnauthorized',
    AI_NOT_FOUND: 'aiNotFound',
    AI_RATE_LIMIT: 'aiRateLimit',
    AI_NETWORK: 'aiNetwork',
    AI_BAD_RESPONSE: 'aiBadResponse',
    AI_NO_MODEL: 'aiNoModel',
  };
  const key = known[code.trim()];
  if (key) return t(key) + (detail ? `（${detail.trim()}）` : '');
  if (code.startsWith('AI_HTTP_')) return t('aiHttpError', { status: code.slice(8) }) + (detail ? `（${detail.trim()}）` : '');
  return raw;
}

function draftOf(id) {
  drafts[id] ??= {
    baseUrl: config.providers[id]?.baseUrl ?? config.defaults[id] ?? '',
    model: config.providers[id]?.model ?? '',
    key: config.providers[id]?.keyHint ? KEEP : '',
    keyHint: config.providers[id]?.keyHint ?? '',
    headers: (config.providers[id]?.headers ?? []).map((h) => ({ name: h.name, value: KEEP, hint: h.value })),
    thinking: config.providers[id]?.thinking ?? '',
    models: [],
  };
  return drafts[id];
}

function requestFor(id) {
  const d = draftOf(id);
  return {
    active: id,
    provider: id,
    baseUrl: d.baseUrl,
    model: d.model,
    key: d.key,
    headers: d.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name, value: h.value })),
    thinking: d.thinking,
    accepted: false,
  };
}

function row(labelKey, ...controls) {
  const wrap = document.createElement('div');
  wrap.className = 'form-row';
  const label = document.createElement('label');
  label.className = 'form-label';
  label.textContent = t(labelKey);
  const field = document.createElement('div');
  field.className = 'form-field';
  field.append(...controls);
  wrap.append(label, field);
  return wrap;
}

function iconButton(icon, key, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tool';
  b.title = t(key);
  b.append(createElement(icon, { width: 16, height: 16 }));
  b.addEventListener('click', onClick);
  return b;
}

function build() {
  root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.id = 'mdb-ai-modal';
  root.hidden = true;
  const box = document.createElement('div');
  box.className = 'modal modal-wide';

  const title = document.createElement('h2');
  title.textContent = t('aiSettings');
  const policyNote = document.createElement('p');
  policyNote.className = 'form-note';

  const provider = document.createElement('select');
  provider.addEventListener('change', () => {
    current = provider.value;
    render();
  });

  const baseUrl = document.createElement('input');
  baseUrl.type = 'text';
  baseUrl.spellcheck = false;
  baseUrl.addEventListener('input', () => (draftOf(current).baseUrl = baseUrl.value));

  const key = document.createElement('input');
  key.type = 'password';
  key.autocomplete = 'off';
  key.spellcheck = false;
  key.addEventListener('input', () => (draftOf(current).key = key.value));
  const reveal = iconButton(Eye, 'aiShowKey', () => {
    key.type = key.type === 'password' ? 'text' : 'password';
    reveal.replaceChildren(createElement(key.type === 'password' ? Eye : EyeOff, { width: 16, height: 16 }));
  });
  const clearKey = iconButton(Trash2, 'aiClearKey', () => {
    const d = draftOf(current);
    d.key = '';
    d.keyHint = '';
    key.value = '';
    render();
  });

  const model = document.createElement('input');
  model.type = 'text';
  model.spellcheck = false;
  model.setAttribute('list', 'mdb-ai-models');
  model.addEventListener('input', () => (draftOf(current).model = model.value));
  const models = document.createElement('datalist');
  models.id = 'mdb-ai-models';
  const fetchModels = document.createElement('button');
  fetchModels.type = 'button';
  fetchModels.className = 'form-button';
  fetchModels.append(createElement(RefreshCw, { width: 15, height: 15 }), document.createTextNode(` ${t('aiFetchModels')}`));
  fetchModels.addEventListener('click', loadModels);

  // 思考模式：空字串代表不指定，請求裡就不會出現任何思考參數
  const thinking = document.createElement('select');
  thinking.addEventListener('change', () => (draftOf(current).thinking = thinking.value));
  const thinkingNote = document.createElement('span');
  thinkingNote.className = 'form-hint';

  const headers = document.createElement('div');
  headers.className = 'ai-headers';
  const addHeader = document.createElement('button');
  addHeader.type = 'button';
  addHeader.className = 'form-button';
  addHeader.append(createElement(Plus, { width: 15, height: 15 }), document.createTextNode(` ${t('aiAddHeader')}`));
  addHeader.addEventListener('click', () => {
    draftOf(current).headers.push({ name: '', value: '' });
    renderHeaders();
  });

  const result = document.createElement('p');
  result.className = 'ai-test-result';

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const test = document.createElement('button');
  test.type = 'button';
  test.append(createElement(Zap, { width: 15, height: 15 }), document.createTextNode(` ${t('aiTest')}`));
  test.addEventListener('click', testConnection);
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = t('btnSave');
  save.addEventListener('click', saveAndClose);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = t('btnCancel');
  cancel.addEventListener('click', close);
  actions.append(test, save, cancel);

  box.append(
    title,
    policyNote,
    row('aiProvider', provider),
    row('aiBaseUrl', baseUrl),
    row('aiApiKey', key, reveal, clearKey),
    row('aiModel', model, models, fetchModels),
    row('aiThinkingMode', thinking, thinkingNote),
    row('aiHeaders', headers, addHeader),
    result,
    actions,
  );
  root.append(box);
  document.body.append(root);
  ui = { provider, baseUrl, key, model, models, thinking, thinkingNote, headers, result, policyNote, test, save };
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) close();
  });
}

function renderHeaders() {
  const d = draftOf(current);
  ui.headers.replaceChildren(
    ...d.headers.map((h, i) => {
      const line = document.createElement('div');
      line.className = 'ai-header-row';
      const name = document.createElement('input');
      name.type = 'text';
      name.placeholder = t('aiHeaderName');
      name.value = h.name;
      name.spellcheck = false;
      name.addEventListener('input', () => (h.name = name.value));
      const value = document.createElement('input');
      value.type = 'text';
      value.placeholder = h.value === KEEP ? `${h.hint} ${t('aiSavedValue')}` : t('aiHeaderValue');
      value.value = h.value === KEEP ? '' : h.value;
      value.spellcheck = false;
      value.addEventListener('input', () => (h.value = value.value));
      const remove = iconButton(Trash2, 'aiRemoveHeader', () => {
        d.headers.splice(i, 1);
        renderHeaders();
      });
      line.append(name, value, remove);
      return line;
    }),
  );
}

// 思考模式選項：值為空字串時請求不帶任何思考參數
const THINKING = [
  ['', 'aiThinkingDefault'],
  ['off', 'aiThinkingOff'],
  ['low', 'aiThinkingLow'],
  ['medium', 'aiThinkingMedium'],
  ['high', 'aiThinkingHigh'],
  ['xhigh', 'aiThinkingXHigh'],
  ['max', 'aiThinkingMax'],
];

function render() {
  const policy = config.policy;
  const allowed = policy.allowedProviders?.length ? policy.allowedProviders : PROVIDERS.map(([id]) => id);
  if (!allowed.includes(current)) current = allowed[0];
  ui.provider.replaceChildren(
    ...PROVIDERS.filter(([id]) => allowed.includes(id)).map(([id, label]) => new Option(label.startsWith('ai') ? t(label) : label, id)),
  );
  ui.provider.value = current;

  const d = draftOf(current);
  const locked = current === 'custom' && Boolean(policy.lockedBaseUrl);
  ui.baseUrl.value = locked ? policy.lockedBaseUrl : d.baseUrl;
  ui.baseUrl.readOnly = locked;
  ui.baseUrl.placeholder = config.defaults[current] || 'https://…/v1';
  ui.key.value = d.key === KEEP ? '' : d.key;
  ui.key.placeholder = d.key === KEEP ? `${d.keyHint} ${t('aiSavedValue')}` : t('aiApiKeyPlaceholder');
  ui.model.value = d.model;
  ui.models.replaceChildren(...d.models.map((m) => new Option(m)));
  ui.thinking.replaceChildren(...THINKING.map(([value, key]) => new Option(t(key), value)));
  ui.thinking.value = d.thinking ?? '';
  ui.thinkingNote.textContent = t('aiThinkingHint');
  renderHeaders();

  const notes = [];
  if (policy.disabled) notes.push(t('aiDisabledByPolicy'));
  if (policy.allowedProviders?.length) notes.push(t('aiPolicyProviders', { list: policy.allowedProviders.join('、') }));
  if (locked) notes.push(t('aiPolicyBaseUrl'));
  ui.policyNote.textContent = notes.join(' ');
  ui.policyNote.hidden = notes.length === 0;
  ui.test.disabled = policy.disabled;
  ui.save.disabled = policy.disabled;
}

function showResult(text, ok) {
  ui.result.textContent = text;
  ui.result.className = 'ai-test-result ' + (ok ? 'ok' : 'error');
}

async function loadModels() {
  showResult(t('aiLoadingModels'), true);
  try {
    const list = await ListAIModels(requestFor(current));
    const d = draftOf(current);
    d.models = list;
    if (!d.model && list.length) d.model = list[0];
    render();
    showResult(list.length ? t('aiModelsLoaded', { count: list.length }) : t('aiNoModels'), list.length > 0);
  } catch (err) {
    showResult(aiErrorMessage(err), false);
  }
}

async function testConnection() {
  showResult(t('aiTesting'), true);
  try {
    const r = await TestAIConnection(requestFor(current));
    showResult(t('aiTestOk', { latency: r.latency, models: r.models }), true);
  } catch (err) {
    showResult(aiErrorMessage(err), false);
  }
}

async function saveAndClose() {
  try {
    await SaveAIConfig(requestFor(current));
    config = await GetAIConfig();
    drafts = {};
    app.flashMessage(t('aiSettingsSaved'));
    close();
  } catch (err) {
    showResult(aiErrorMessage(err), false);
  }
}

function close() {
  root.hidden = true;
  document.removeEventListener('keydown', onKey, true);
}

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

export async function openAISettings() {
  config = await GetAIConfig();
  drafts = {};
  current = config.active || 'openai';
  if (!root) build();
  render();
  root.hidden = false;
  document.addEventListener('keydown', onKey, true);
  ui.result.textContent = '';
  ui.baseUrl.focus();
}

// 目前的設定（AI 對話面板用；沒設定完成時回傳 null）
export async function aiReady() {
  config = await GetAIConfig();
  if (config.policy.disabled) return null;
  const provider = config.providers[config.active];
  return provider?.model && (provider.keyHint || config.active === 'custom') ? { provider: config.active, model: provider.model } : null;
}

// 第一次使用 AI 前的資料傳送提醒
export async function ensureAIConsent() {
  config = await GetAIConfig();
  if (config.policy.disabled) {
    await app.showError(t('aiDisabledByPolicy'));
    return false;
  }
  if (config.accepted) return true;
  const answer = await app.showModal(t('aiConsentTitle'), t('aiConsentMessage'), [
    { label: t('aiConsentAccept'), value: 'ok', primary: true },
    { label: t('btnCancel'), value: 'cancel' },
  ]);
  if (answer !== 'ok') return false;
  await SaveAIConfig({ accepted: true, provider: '', active: config.active, baseUrl: '', model: '', key: KEEP, headers: null });
  config = await GetAIConfig();
  return true;
}
