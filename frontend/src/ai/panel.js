// AI 面板（視窗右側）：對話、以開啟的分頁作為討論內容、常用動作、把結果套用到文件。
import { createElement, Bot, Send, Square, Trash2, Settings, X, ClipboardCopy, CornerDownLeft, Replace, FileDown } from 'lucide';
import { StartAIChat, CancelAIChat, LoadState, SaveState, ImportTargets } from '../../wailsjs/go/main/App';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { t, getLanguage, applyToDom } from '../i18n.js';
import { renderPreview } from '../preview.js';
import { isEditorKind } from '../kinds.js';
import { importDocument } from '../importer.js';
import { openAISettings, ensureAIConsent, aiReady, aiErrorMessage } from './settings.js';
import { showDiff } from './diff.js';

const MAX_DOC_CHARS = 40000; // 單一文件送出的上限
const MAX_HISTORY = 12; // 帶入的對話輪數
const $ = (id) => document.getElementById(id);

let app = null;
let panel = null;
let ui = {};
let layout = { open: false, width: 400 };
let messages = []; // { role, content, mode?, error? }
let selected = new Set(); // 勾選的分頁 id
let streaming = null; // { id, index, mode }
const pdfTextCache = new Map();

// ---- 常用動作 ----
const QUICK_ACTIONS = [
  { key: 'aiActionSummary', mode: 'chat', prompt: 'promptSummary' },
  { key: 'aiActionPolish', mode: 'rewrite', prompt: 'promptPolish' },
  { key: 'aiActionTranslateEn', mode: 'rewrite', prompt: 'promptTranslateEn' },
  { key: 'aiActionTranslateZh', mode: 'rewrite', prompt: 'promptTranslateZh' },
  { key: 'aiActionComment', mode: 'rewrite', prompt: 'promptComment' },
  { key: 'aiActionFix', mode: 'rewrite', prompt: 'promptFix' },
  { key: 'aiActionDoc', mode: 'newdoc', prompt: 'promptDoc' },
];

function saveLayout() {
  SaveState('ai.panel', JSON.stringify(layout));
}

function saveChat() {
  SaveState('ai.chat', JSON.stringify({ messages: messages.slice(-60) }));
}

// ---- 版面 ----
export function toggleAIPanel(forceOpen = false) {
  layout.open = forceOpen ? true : !layout.open;
  applyPanelLayout();
  saveLayout();
  if (layout.open) {
    ui.input.focus();
    renderContext();
  }
}

function applyPanelLayout() {
  panel.hidden = !layout.open;
  $('mdb-ai-resizer').hidden = !layout.open;
  document.querySelector('.app-body').style.setProperty('--ai-width', `${layout.width}px`);
  $('mdb-ai-toggle')?.classList.toggle('active', layout.open);
}

function initResizer() {
  const handle = $('mdb-ai-resizer');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = layout.width;
    const move = (ev) => {
      layout.width = Math.min(760, Math.max(280, startWidth - (ev.clientX - startX)));
      document.querySelector('.app-body').style.setProperty('--ai-width', `${layout.width}px`);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      saveLayout();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// ---- 介面 ----
function iconButton(icon, key, onClick, className = 'tool') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.dataset.i18nTitle = key;
  b.title = t(key);
  b.append(createElement(icon, { width: 16, height: 16 }));
  b.addEventListener('click', onClick);
  return b;
}

function build() {
  panel = $('mdb-ai-panel');
  const header = document.createElement('div');
  header.className = 'ai-header';
  const title = document.createElement('span');
  title.className = 'ai-title';
  title.append(createElement(Bot, { width: 16, height: 16 }), document.createTextNode(` ${t('aiAssistant')}`));
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  header.append(
    title,
    spacer,
    iconButton(Trash2, 'aiClearChat', clearChat),
    iconButton(Settings, 'settings', () => openAISettings()),
    iconButton(X, 'aiClosePanel', () => toggleAIPanel()),
  );

  const context = document.createElement('div');
  context.className = 'ai-context';

  const actions = document.createElement('div');
  actions.className = 'ai-actions';
  for (const action of QUICK_ACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-action';
    b.dataset.i18n = action.key;
    b.textContent = t(action.key);
    b.addEventListener('click', () => send(t(action.prompt), action.mode));
    actions.append(b);
  }

  const list = document.createElement('div');
  list.className = 'ai-messages';

  const composer = document.createElement('div');
  composer.className = 'ai-composer';
  const input = document.createElement('textarea');
  input.rows = 3;
  input.dataset.i18nPlaceholder = 'aiInputPlaceholder';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  });
  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.className = 'ai-send';
  sendButton.addEventListener('click', () => (streaming ? stop() : submit()));
  composer.append(input, sendButton);

  panel.replaceChildren(header, context, actions, list, composer);
  ui = { context, list, input, sendButton };
  applyToDom(panel);
  updateSendButton();
}

function updateSendButton() {
  ui.sendButton.replaceChildren(
    createElement(streaming ? Square : Send, { width: 15, height: 15 }),
    document.createTextNode(` ${t(streaming ? 'aiStop' : 'aiSend')}`),
  );
  ui.sendButton.classList.toggle('stop', Boolean(streaming));
}

// ---- 參考文件（勾選分頁）----
function renderContext() {
  const chips = app.tabs.map((tab) => {
    const label = document.createElement('label');
    label.className = 'ai-chip' + (selected.has(tab.id) ? ' on' : '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(tab.id);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(tab.id);
      else selected.delete(tab.id);
      renderContext();
    });
    const name = document.createElement('span');
    name.textContent = app.fileName(tab.path);
    label.append(box, name);
    label.title = tab.path || app.fileName(tab.path);
    return label;
  });
  const hint = document.createElement('span');
  hint.className = 'ai-context-hint';
  hint.textContent = t('aiContextHint');
  ui.context.replaceChildren(hint, ...chips);
}

// 取得分頁內容（PDF 抽取文字並快取；過長時截斷）
async function tabText(tab) {
  if (isEditorKind(tab.kind)) return app.textOf(tab);
  if (tab.kind === 'pdf' && tab.path) {
    if (!pdfTextCache.has(tab.path)) {
      const target = await ImportTargets(tab.path, []);
      pdfTextCache.set(tab.path, await importDocument(tab.path, target, { slide: t('slide') }));
    }
    return pdfTextCache.get(tab.path);
  }
  return null;
}

async function buildContextMessage() {
  const parts = [];
  const notes = [];
  let chars = 0;
  for (const tab of app.tabs) {
    if (!selected.has(tab.id)) continue;
    let text = null;
    try {
      text = await tabText(tab);
    } catch {
      text = null;
    }
    if (text == null) {
      notes.push(t('aiContextSkipped', { name: app.fileName(tab.path) }));
      continue;
    }
    if (!text.trim()) {
      notes.push(t('aiContextEmpty', { name: app.fileName(tab.path) }));
      continue;
    }
    let truncated = false;
    if (text.length > MAX_DOC_CHARS) {
      text = text.slice(0, MAX_DOC_CHARS);
      truncated = true;
      notes.push(t('aiContextTruncated', { name: app.fileName(tab.path) }));
    }
    const fence = text.includes('```') ? '````' : '```';
    chars += text.length;
    parts.push(`### ${app.fileName(tab.path)}${truncated ? t('aiTruncatedMark') : ''}\n${fence}\n${text}\n${fence}`);
  }
  if (!parts.length) {
    setNotice(notes.join(' '));
    return null;
  }
  // 讓使用者看得到這次真的送了多少內容出去
  notes.unshift(t('aiContextSent', { count: parts.length, chars: chars.toLocaleString() }));
  setNotice(notes.join(' '));
  return `${t('aiContextIntro')}\n\n${parts.join('\n\n')}`;
}

function setNotice(text) {
  ui.context.dataset.notice = text;
  let note = ui.context.querySelector('.ai-context-note');
  if (!text) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement('div');
    note.className = 'ai-context-note';
    ui.context.append(note);
  }
  note.textContent = text;
}

// ---- 對話顯示 ----
function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```([\w+-]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) blocks.push({ lang: m[1], code: m[2] });
  return blocks;
}

function actionBar(code, lang, mode) {
  const bar = document.createElement('div');
  bar.className = 'ai-code-actions';
  const add = (icon, key, onClick) => bar.append(iconButton(icon, key, onClick, 'ai-mini'));
  add(CornerDownLeft, 'aiInsertAtCursor', () => app.insertText(code));
  add(Replace, 'aiReplaceSelection', () => app.replaceSelection(code));
  add(FileDown, 'aiOpenAsTab', () => app.openDraft(code, lang === 'md' || lang === 'markdown' || mode === 'newdoc' ? 'markdown' : 'text'));
  add(ClipboardCopy, 'aiCopy', () => navigator.clipboard?.writeText(code));
  return bar;
}

function renderMessage(message, index) {
  const item = document.createElement('div');
  item.className = `ai-message ai-${message.role}` + (message.error ? ' ai-error' : '');
  if (message.role === 'user') {
    item.textContent = message.content;
    return item;
  }
  // 思考過程：答案還沒出現時自動展開，答案開始出現後收合
  if (message.think?.trim()) {
    const details = document.createElement('details');
    details.className = 'ai-think';
    details.open = message.thinkOpen ?? !message.content.trim();
    const summary = document.createElement('summary');
    summary.textContent = t('aiThinkTitle');
    // 只記使用者自己的點擊；程式設定 open 也會發出 toggle 事件，不能用它判斷
    summary.addEventListener('click', () => (message.thinkOpen = !details.open));
    const text = document.createElement('div');
    text.className = 'ai-think-text';
    text.textContent = message.think;
    details.append(summary, text);
    item.append(details);
  }
  const body = document.createElement('div');
  body.className = 'markdown-body ai-markdown';
  if (message.content.trim()) renderPreview(body, message.content);
  else if (!message.think?.trim()) body.innerHTML = `<p class="ai-typing">${t('aiThinking')}</p>`;
  item.append(body);
  if (message.error) return item;

  // 程式碼區塊的套用按鈕
  const blocks = extractCodeBlocks(message.content);
  body.querySelectorAll('pre').forEach((pre, i) => {
    const block = blocks[i];
    if (block) pre.before(actionBar(block.code, block.lang, message.mode));
  });
  // 整份改寫：提供差異比較後套用
  if ((message.mode === 'rewrite' || message.mode === 'newdoc') && message.done) {
    const candidate = blocks[0]?.code ?? message.content;
    const footer = document.createElement('div');
    footer.className = 'ai-message-footer';
    if (message.mode === 'rewrite') {
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'ai-apply';
      apply.textContent = t('aiApplyToDocument');
      apply.addEventListener('click', () => applyRewrite(candidate));
      footer.append(apply);
    } else {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'ai-apply';
      open.textContent = t('aiOpenAsNewTab');
      open.addEventListener('click', () => app.openDraft(candidate, 'markdown'));
      footer.append(open);
    }
    item.append(footer);
  }
  item.dataset.index = index;
  return item;
}

function renderMessages(keepScroll = false) {
  const atBottom = ui.list.scrollTop + ui.list.clientHeight >= ui.list.scrollHeight - 40;
  ui.list.replaceChildren(...messages.map(renderMessage));
  if (!keepScroll || atBottom) ui.list.scrollTop = ui.list.scrollHeight;
}

// ---- 送出與串流 ----
function systemMessage() {
  return { role: 'system', content: t('aiSystemPrompt', { lang: getLanguage() === 'en' ? 'English' : '繁體中文' }) };
}

async function send(prompt, mode = 'chat') {
  if (streaming) return;
  if (!(await ensureAIConsent())) return;
  const ready = await aiReady();
  if (!ready) {
    messages.push({ role: 'assistant', content: t('aiNotConfigured'), error: true, done: true });
    renderMessages();
    openAISettings();
    return;
  }
  const context = await buildContextMessage();
  messages.push({ role: 'user', content: prompt });
  const history = messages
    .filter((m) => !m.error)
    .slice(-MAX_HISTORY)
    .map(({ role, content }) => ({ role, content }));
  // 文件內容併進「這一次的問題」同一則訊息：有些服務會合併或丟掉連續的 user 訊息，
  // 分開送會讓模型看不到文件。
  if (context) history[history.length - 1].content = `${context}\n\n---\n\n${prompt}`;
  const request = [systemMessage(), ...history];
  const id = `chat-${Date.now()}`;
  messages.push({ role: 'assistant', content: '', mode, done: false });
  streaming = { id, index: messages.length - 1, mode };
  updateSendButton();
  renderMessages();
  try {
    await StartAIChat(id, request);
  } catch (err) {
    finishStreaming(aiErrorMessage(err), true);
  }
}

function submit() {
  const text = ui.input.value.trim();
  if (!text) return;
  ui.input.value = '';
  send(text, 'chat');
}

function stop() {
  if (streaming) CancelAIChat(streaming.id);
}

function finishStreaming(errorText = null, isError = false) {
  if (!streaming) return;
  const message = messages[streaming.index];
  if (message) {
    message.done = true;
    if (isError) {
      message.content = errorText;
      message.error = true;
    } else if (!message.content.trim()) {
      message.content = t('aiEmptyReply');
      message.error = true;
    }
  }
  streaming = null;
  updateSendButton();
  renderMessages();
  saveChat();
}

async function applyRewrite(text) {
  const tab = app.active;
  if (!isEditorKind(tab.kind)) {
    await app.showError(t('aiApplyNeedsEditor'));
    return;
  }
  const before = app.textOf(tab);
  if (before === text) {
    app.flashMessage(t('aiApplyNoChange'));
    return;
  }
  const ok = await showDiff({ title: t('aiApplyToDocument'), before, after: text });
  if (!ok) return;
  app.replaceDocument(text);
  app.flashMessage(t('aiApplied'));
}

function clearChat() {
  messages = [];
  saveChat();
  renderMessages();
}

// ---- 初始化 ----
export async function initAIPanel(appApi, disabled = false) {
  app = appApi;
  build();
  initResizer();
  try {
    layout = { ...layout, ...JSON.parse((await LoadState('ai.panel')) || '{}') };
  } catch {
    /* 使用預設 */
  }
  if (disabled) layout.open = false; // 公司政策停用 AI 時，面板一律收起
  try {
    messages = JSON.parse((await LoadState('ai.chat')) || '{}').messages ?? [];
  } catch {
    messages = [];
  }
  messages.forEach((m) => (m.done = true));
  applyPanelLayout();
  renderMessages();
  if (app.active) selected = new Set([app.active.id]);
  renderContext();

  app.on('active', (tab) => {
    // 切換分頁時，預設把新分頁加入參考（使用者仍可自行取消）
    if (tab && selected.size <= 1) selected = new Set([tab.id]);
    if (layout.open) renderContext();
  });
  app.on('tabs', () => {
    for (const id of [...selected]) if (!app.tabs.some((tab) => tab.id === id)) selected.delete(id);
    if (layout.open) renderContext();
  });
  app.on('language', () => {
    build();
    applyPanelLayout();
    renderMessages();
    renderContext();
  });

  EventsOn('ai:delta', (id, text) => {
    if (streaming?.id !== id) return;
    const message = messages[streaming.index];
    message.content += text;
    renderMessages(true);
  });
  EventsOn('ai:think', (id, text) => {
    if (streaming?.id !== id) return;
    const message = messages[streaming.index];
    message.think = (message.think ?? '') + text;
    renderMessages(true);
  });
  EventsOn('ai:done', (id) => {
    if (streaming?.id === id) finishStreaming();
  });
  EventsOn('ai:error', (id, message) => {
    if (streaming?.id === id) finishStreaming(aiErrorMessage({ message }), true);
  });
}
