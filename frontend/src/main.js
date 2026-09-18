import './style.css';
import 'highlight.js/styles/github.css';
import {
  createElement,
  FilePlus, FolderOpen, Save, SaveAll,
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3,
  List, ListOrdered, ListTodo, TextQuote,
  Code, SquareCode, Link, Image, Table, Minus,
  PenLine, Columns2, Eye, Languages, Sigma, Plus, X, FileDown, FileText,
} from 'lucide';
import {
  GetStartupFiles, LoadSettings, SaveSettings, OpenFileDialog, SaveFileDialog,
  ReadFile, SaveFile, SetDirty, SetDocPath, ResolvePath, Quit,
  ExportDialog, ExportPDF, WriteBase64File, OpenWithDefaultApp, ImportTargets,
  IsDefaultMarkdownApp, ShowDefaultAppDialog,
  CheckForUpdate, ApplyUpdate, WasUpdated, GetVersion,
} from '../wailsjs/go/main/App';
import { EventsOn, OnFileDrop, WindowSetTitle, BrowserOpenURL } from '../wailsjs/runtime/runtime';
import { t, setLanguage, getLanguage, detectLanguage, languages, applyToDom } from './i18n.js';
import { createEditor, commands } from './editor.js';
import { renderPreview, lineAnchors } from './preview.js';
import { buildHtml, buildDocx } from './export.js';
import { IMPORTABLE, UNSUPPORTED, importDocument } from './importer.js';

const $ = (id) => document.getElementById(id);
const workspace = $('mdb-workspace');
const previewScroll = $('mdb-preview-scroll');
const preview = $('mdb-preview');
const tabBar = $('mdb-tabs');

// ---- 分頁狀態 ----
// 所有分頁共用同一個編輯器，每個分頁保存自己的 EditorState（內容、游標、復原紀錄）與捲動位置。
// 作用中分頁的最新狀態永遠在 view.state，切換時才寫回 tab.state。
let tabs = [];
let active = null;
let tabSeq = 0;
let viewMode = 'split';
let settings = { language: '', defaultPrompt: '' };

const editor = createEditor($('mdb-editor'), {
  onChange: () => {
    updateDirty();
    scheduleRender();
  },
  onCursor: updateStatusInfo,
});
const view = editor.view;

function fileName(path) {
  return path ? path.split(/[\\/]/).pop() : t('untitled');
}

function samePath(a, b) {
  return a && b && a.toLowerCase() === b.toLowerCase();
}

function updateTitle() {
  WindowSetTitle(`${fileName(active.path)}${active.dirty ? ' *' : ''} - ${t('appName')}`);
}

function syncGlobalDirty() {
  SetDirty(tabs.some((tab) => tab.dirty));
}

function updateDirty() {
  const now = !view.state.doc.eq(active.savedDoc);
  if (now === active.dirty) return;
  active.dirty = now;
  syncGlobalDirty();
  updateTitle();
  renderTabs();
}

function updateStatusInfo() {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  $('mdb-status-path').textContent = active.path || t('untitled');
  $('mdb-status-info').textContent = [
    active.encoding,
    active.crlf ? 'CRLF' : 'LF',
    t('lineCol', { line: line.number, col: pos - line.from + 1 }),
  ].join('   ');
}

let messageTimer;
function flashMessage(text) {
  const el = $('mdb-status-message');
  el.textContent = text;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (el.textContent = ''), 2500);
}

// ---- 預覽 ----
let renderTimer;
let anchorsCache = null;

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 120);
}

function render(sync = true) {
  clearTimeout(renderTimer);
  const source = view.state.doc.toString();
  if (source.trim() === '') {
    preview.innerHTML = `<p class="empty-hint">${t('emptyPreview')}</p>`;
  } else {
    renderPreview(preview, source).then(invalidateAnchors);
    preview.querySelectorAll('img').forEach((img) => img.addEventListener('load', invalidateAnchors, { once: true }));
  }
  invalidateAnchors();
  if (sync) syncScroll('editor');
}

function invalidateAnchors() {
  anchorsCache = null;
}

function anchors() {
  anchorsCache ??= lineAnchors(previewScroll);
  return anchorsCache;
}

// ---- 同步捲動（分割模式）----
// 以「使用者目前操作的那一邊」為主，帶動另一邊，避免兩邊互相觸發
let scrollLeader = 'editor';

function editorTopLine() {
  const sc = view.scrollDOM;
  const height = sc.getBoundingClientRect().top - view.documentTop;
  const block = view.lineBlockAtHeight(Math.max(0, height));
  const line = view.state.doc.lineAt(block.from).number - 1;
  const frac = block.height ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0;
  return line + frac;
}

function interpolate(list, value, fromIdx, toIdx) {
  // list: [[line, y], ...]，以 fromIdx 欄位內插出 toIdx 欄位
  let prev = [0, 0];
  for (const item of list) {
    if (item[fromIdx] > value) {
      const span = item[fromIdx] - prev[fromIdx];
      const ratio = span > 0 ? (value - prev[fromIdx]) / span : 0;
      return prev[toIdx] + ratio * (item[toIdx] - prev[toIdx]);
    }
    prev = item;
  }
  return null; // 超過最後一個錨點
}

function syncScroll(source) {
  if (viewMode !== 'split') return;
  const sc = view.scrollDOM;
  const list = anchors();
  if (source === 'editor') {
    let y;
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) {
      y = previewScroll.scrollHeight;
    } else {
      const line = editorTopLine();
      y = interpolate(list, line, 0, 1);
      if (y === null) {
        const last = list[list.length - 1] ?? [0, 0];
        const total = view.state.doc.lines;
        const ratio = total > last[0] ? (line - last[0]) / (total - last[0]) : 1;
        y = last[1] + ratio * (previewScroll.scrollHeight - last[1]);
      }
    }
    previewScroll.scrollTop = y;
  } else {
    const y = previewScroll.scrollTop;
    let line;
    if (y + previewScroll.clientHeight >= previewScroll.scrollHeight - 4) {
      line = view.state.doc.lines;
    } else {
      line = interpolate(list, y, 1, 0) ?? view.state.doc.lines;
    }
    const n = Math.min(view.state.doc.lines, Math.floor(line) + 1);
    const block = view.lineBlockAt(view.state.doc.line(n).from);
    const offset = view.documentTop - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTop = block.top + (line - Math.floor(line)) * block.height + offset;
  }
}

for (const [name, el] of [['editor', view.scrollDOM], ['preview', previewScroll]]) {
  for (const evt of ['pointerenter', 'pointerdown', 'wheel', 'keydown', 'focusin']) {
    el.addEventListener(evt, () => (scrollLeader = name), { passive: true });
  }
  el.addEventListener('scroll', () => {
    if (scrollLeader === name) requestAnimationFrame(() => syncScroll(name));
  }, { passive: true });
}
window.addEventListener('resize', invalidateAnchors);

// ---- 對話框 ----
let modalOpen = false;

// buttons: [{ label, value, primary }]；Esc 回傳 cancelValue
function showModal(title, message, buttons, cancelValue = 'cancel') {
  const modal = $('mdb-modal');
  const actions = $('mdb-modal-actions');
  $('mdb-modal-title').textContent = title;
  $('mdb-modal-message').textContent = message;
  actions.replaceChildren();
  modalOpen = true;
  modal.hidden = false;
  return new Promise((resolve) => {
    const close = (value) => {
      modal.hidden = true;
      modalOpen = false;
      document.removeEventListener('keydown', onKey, true);
      view.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(cancelValue);
      }
    };
    document.addEventListener('keydown', onKey, true);
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      btn.className = b.primary ? 'primary' : '';
      btn.addEventListener('click', () => close(b.value));
      actions.append(btn);
    }
    actions.querySelector('.primary')?.focus();
  });
}

function showError(message) {
  return showModal(t('errorTitle'), message, [{ label: t('btnOk'), value: 'ok', primary: true }], 'ok');
}

// 分頁有未存變更時先切過去再詢問；回傳 true 表示可以繼續（已存檔或放棄變更）
async function confirmDiscard(tab) {
  if (!tab.dirty) return true;
  activate(tab);
  const answer = await showModal(t('unsavedTitle'), t('unsavedMessage', { name: fileName(tab.path) }), [
    { label: t('btnSave'), value: 'save', primary: true },
    { label: t('btnDiscard'), value: 'discard' },
    { label: t('btnCancel'), value: 'cancel' },
  ]);
  if (answer === 'save') return save();
  return answer === 'discard';
}

// ---- 分頁 ----
function createTab(info, content) {
  const state = editor.createState(content);
  return {
    id: ++tabSeq,
    path: '',
    encoding: 'UTF-8',
    crlf: false,
    bom: false,
    ...info,
    state,
    savedDoc: state.doc,
    dirty: false,
    editorScroll: 0,
    previewScroll: 0,
  };
}

// 空白、未命名、未修改的分頁：開檔時直接被取代
function isPristine(tab) {
  const doc = tab === active ? view.state.doc : tab.state.doc;
  return !tab.path && !tab.dirty && doc.length === 0;
}

function activate(tab) {
  if (tab === active) return;
  if (active && tabs.includes(active)) {
    active.state = view.state;
    active.editorScroll = view.scrollDOM.scrollTop;
    active.previewScroll = previewScroll.scrollTop;
  }
  active = tab;
  view.setState(tab.state);
  SetDocPath(tab.path);
  updateTitle();
  updateStatusInfo();
  renderTabs();
  render(false);
  const { editorScroll, previewScroll: pvScroll } = tab;
  requestAnimationFrame(() => {
    view.scrollDOM.scrollTop = editorScroll;
    previewScroll.scrollTop = pvScroll;
  });
  view.focus();
}

function addTab(info = {}, content = '') {
  const tab = createTab(info, content);
  tabs.push(tab);
  activate(tab);
  return tab;
}

function removeTab(tab) {
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  tabs.splice(index, 1);
  if (!tabs.length) {
    addTab();
  } else if (tab === active) {
    activate(tabs[Math.min(index, tabs.length - 1)]);
  }
  syncGlobalDirty();
  renderTabs();
}

async function closeTab(tab = active) {
  if (!(await confirmDiscard(tab))) return false;
  removeTab(tab);
  return true;
}

function cycleTab(step) {
  const index = tabs.indexOf(active);
  activate(tabs[(index + step + tabs.length) % tabs.length]);
}

function renderTabs() {
  const items = tabs.map((tab) => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab === active ? ' active' : '') + (tab.dirty ? ' dirty' : '');
    el.title = tab.path || t('untitled');
    el.dataset.tabId = tab.id;
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = fileName(tab.path);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.title = t('closeTab');
    close.append(createElement(X, { width: 14, height: 14 }));
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab);
    });
    el.append(name, close);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab);
      }
    });
    el.addEventListener('click', () => activate(tab));
    return el;
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'tab-add';
  add.title = t('newFile');
  add.append(createElement(Plus, { width: 16, height: 16 }));
  add.addEventListener('click', newFile);
  tabBar.replaceChildren(...items, add);
  tabBar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---- 檔案操作 ----
function newFile() {
  addTab();
}

// 開啟檔案成為分頁；已開啟則切換過去；目前是空白分頁則取代它；Word / Excel 等文件自動轉換
async function openPath(path) {
  const existing = tabs.find((tab) => samePath(tab.path, path));
  if (existing) {
    activate(existing);
    return;
  }
  if (UNSUPPORTED.test(path)) {
    await showError(t('unsupportedFormat', { name: fileName(path) }));
    return;
  }
  if (IMPORTABLE.test(path)) {
    await importPath(path);
    return;
  }
  let d;
  try {
    d = await ReadFile(path);
  } catch (err) {
    await showError(t('openFailed', { error: String(err) }));
    return;
  }
  const reuse = active && isPristine(active) ? active : null;
  addTab({ path: d.path, encoding: d.encoding, crlf: d.crlf, bom: d.bom }, d.content);
  if (reuse) removeTab(reuse);
}

// 轉換文件成 Markdown，開成未存檔的新分頁（預設存到原檔旁的「原檔名.md」）
async function importPath(path) {
  document.body.classList.add('busy');
  clearTimeout(messageTimer);
  $('mdb-status-message').textContent = t('importing');
  let result;
  try {
    const target = await ImportTargets(path, tabs.map((tab) => tab.path).filter(Boolean));
    result = { path: target.markdownPath, markdown: await importDocument(path, target, { slide: t('slide') }) };
  } catch (err) {
    $('mdb-status-message').textContent = '';
    await showError(t('importFailed', { name: fileName(path), error: String(err?.message ?? err) }));
    return;
  } finally {
    document.body.classList.remove('busy');
  }
  const reuse = active && isPristine(active) ? active : null;
  const tab = addTab({ path: result.path }, result.markdown);
  if (reuse) removeTab(reuse);
  // 尚未存檔：以空白內容當作「已存」基準，分頁會顯示未存檔
  tab.savedDoc = editor.createState('').doc;
  tab.dirty = true;
  syncGlobalDirty();
  updateTitle();
  renderTabs();
  flashMessage(t('importedFrom', { name: fileName(path) }));
}

async function openFile(path) {
  const paths = path
    ? [path]
    : await OpenFileDialog(t('dialogOpenTitle'), t('supportedFiles'), t('markdownFiles'), t('allFiles'));
  for (const p of paths ?? []) await openPath(p);
}

async function writeTo(path) {
  const tab = active;
  try {
    await SaveFile(path, view.state.doc.toString(), tab.crlf, tab.bom);
  } catch (err) {
    await showError(t('saveFailed', { error: String(err) }));
    return false;
  }
  const pathChanged = path !== tab.path;
  tab.path = path;
  tab.encoding = 'UTF-8'; // 存檔一律為 UTF-8（Big5 開啟的檔案存檔後即轉為 UTF-8）
  tab.savedDoc = view.state.doc;
  tab.dirty = false;
  syncGlobalDirty();
  if (pathChanged) {
    SetDocPath(path);
    render(); // 資料夾變了，相對路徑圖片要重新解析
  }
  updateTitle();
  updateStatusInfo();
  renderTabs();
  flashMessage(t('saved'));
  return true;
}

async function save() {
  return active.path ? writeTo(active.path) : saveAs();
}

async function saveAs() {
  const defaultName = active.path ? fileName(active.path) : `${t('untitled')}.md`;
  const path = await SaveFileDialog(t('dialogSaveTitle'), defaultName, t('markdownFiles'), t('allFiles'));
  if (!path) return false;
  // 另存成另一個已開啟的檔案時，關掉那個舊分頁，避免同一檔案開兩次
  const duplicate = tabs.find((tab) => tab !== active && samePath(tab.path, path));
  const ok = await writeTo(path);
  if (ok && duplicate) removeTab(duplicate);
  return ok;
}

// ---- 匯出 PDF / Word ----
let exporting = false;

async function exportAs(kind) {
  if (exporting) return;
  const ext = kind === 'pdf' ? 'pdf' : 'docx';
  const base = active.path ? fileName(active.path).replace(/\.[^.]+$/, '') : t('untitled');
  const path = await ExportDialog(
    t(kind === 'pdf' ? 'exportPdf' : 'exportWord'),
    `${base}.${ext}`,
    t(kind === 'pdf' ? 'pdfFiles' : 'wordFiles'),
    ext,
  );
  if (!path) return;
  exporting = true;
  document.body.classList.add('busy');
  const status = $('mdb-status-message');
  clearTimeout(messageTimer);
  status.textContent = t('exporting');
  let error = null;
  try {
    const source = view.state.doc.toString();
    if (kind === 'pdf') await ExportPDF(await buildHtml(source, base), path);
    else await WriteBase64File(path, await buildDocx(source, base));
  } catch (err) {
    error = err;
  } finally {
    exporting = false;
    document.body.classList.remove('busy');
    status.textContent = '';
  }
  if (error) {
    await showError(t('exportFailed', { error: String(error?.message ?? error) }));
    return;
  }
  const answer = await showModal(t('exportDoneTitle'), t('exportDoneMessage', { name: fileName(path) }), [
    { label: t('btnOpen'), value: 'open', primary: true },
    { label: t('btnClose'), value: 'close' },
  ], 'close');
  if (answer === 'open') OpenWithDefaultApp(path).catch((err) => showError(String(err)));
}

// ---- 檢視模式 ----
function setViewMode(mode) {
  viewMode = mode;
  workspace.className = `workspace mode-${mode}`;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
  invalidateAnchors();
  view.requestMeasure();
  if (mode !== 'preview') view.focus();
  if (mode === 'split') requestAnimationFrame(() => syncScroll('editor'));
}

// ---- 語言 ----
function changeLanguage(code) {
  setLanguage(code);
  updateTitle();
  updateStatusInfo();
  renderTabs();
  if (view.state.doc.length === 0) render();
  settings.language = code;
  SaveSettings(settings);
}

// ---- 預設程式（.md 檔案關聯）----
async function refreshDefaultLink() {
  $('mdb-set-default').hidden = await IsDefaultMarkdownApp();
}

async function setAsDefault() {
  try {
    await ShowDefaultAppDialog();
  } catch (err) {
    await showError(String(err));
  }
  await refreshDefaultLink();
}

// 不是預設程式時，第一次啟動詢問（使用者選「不要再問」後就不再出現）
async function promptDefaultApp() {
  if (settings.defaultPrompt === 'never' || (await IsDefaultMarkdownApp())) return;
  const answer = await showModal(t('setDefault'), t('defaultMessage'), [
    { label: t('btnSetDefault'), value: 'set', primary: true },
    { label: t('btnLater'), value: 'later' },
    { label: t('btnNever'), value: 'never' },
  ], 'later');
  if (answer === 'set') await setAsDefault();
  if (answer === 'never') {
    settings.defaultPrompt = 'never';
    SaveSettings(settings);
  }
}

$('mdb-set-default').addEventListener('click', setAsDefault);

// ---- 工具列 ----
const toolbarGroups = [
  [
    { icon: FilePlus, key: 'newFile', run: newFile },
    { icon: FolderOpen, key: 'openFile', run: () => openFile() },
    { icon: Save, key: 'save', run: save },
    { icon: SaveAll, key: 'saveAs', run: saveAs },
  ],
  [
    { icon: FileDown, key: 'exportPdf', run: () => exportAs('pdf') },
    { icon: FileText, key: 'exportWord', run: () => exportAs('docx') },
  ],
  [
    { icon: Bold, key: 'bold' },
    { icon: Italic, key: 'italic' },
    { icon: Strikethrough, key: 'strike' },
    { icon: Heading1, key: 'h1' },
    { icon: Heading2, key: 'h2' },
    { icon: Heading3, key: 'h3' },
  ],
  [
    { icon: List, key: 'bulletList' },
    { icon: ListOrdered, key: 'orderedList' },
    { icon: ListTodo, key: 'taskList' },
    { icon: TextQuote, key: 'quote' },
  ],
  [
    { icon: Code, key: 'inlineCode' },
    { icon: SquareCode, key: 'codeBlock' },
    { icon: Link, key: 'link' },
    { icon: Image, key: 'image' },
    { icon: Table, key: 'table' },
    { icon: Minus, key: 'hr' },
    { icon: Sigma, key: 'math' },
  ],
];

function iconButton(icon, key, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tool';
  btn.dataset.i18nTitle = key;
  btn.append(createElement(icon, { width: 18, height: 18, 'stroke-width': 2 }));
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // 不搶走編輯區的焦點與選取
  btn.addEventListener('click', onClick);
  return btn;
}

function buildToolbar() {
  const bar = $('mdb-toolbar');
  toolbarGroups.forEach((group, i) => {
    const g = document.createElement('div');
    g.className = 'tool-group';
    for (const item of group) {
      g.append(
        iconButton(item.icon, item.key, () => {
          if (item.run) return item.run();
          if (viewMode === 'preview') setViewMode('split'); // 只預覽時按格式鈕，先切回可編輯
          commands[item.key](view);
        }),
      );
    }
    bar.append(g);
    if (i === 0) g.classList.add('file-group');
  });

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  bar.append(spacer);

  const modes = document.createElement('div');
  modes.className = 'tool-group segmented';
  for (const [mode, icon, key] of [['edit', PenLine, 'viewEdit'], ['split', Columns2, 'viewSplit'], ['preview', Eye, 'viewPreview']]) {
    const btn = iconButton(icon, key, () => setViewMode(mode));
    btn.dataset.view = mode;
    modes.append(btn);
  }
  bar.append(modes);

  const lang = document.createElement('label');
  lang.className = 'lang-select';
  lang.dataset.i18nTitle = 'language';
  lang.append(createElement(Languages, { width: 16, height: 16 }));
  const select = document.createElement('select');
  select.id = 'mdb-language';
  for (const l of languages) select.append(new Option(l.label, l.code));
  select.addEventListener('change', () => changeLanguage(select.value));
  lang.append(select);
  bar.append(lang);
}

// ---- 快捷鍵（檔案 / 分頁類；格式類在 editor.js）----
document.addEventListener(
  'keydown',
  (e) => {
    if (modalOpen) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    // 擋掉會讓 WebView 重新整理而遺失內容的按鍵
    if (e.key === 'F5' || (ctrl && k === 'r')) {
      e.preventDefault();
      return;
    }
    if (!ctrl || e.altKey) return;
    const actions = {
      n: newFile,
      o: () => openFile(),
      s: e.shiftKey ? saveAs : save,
      w: () => closeTab(),
      tab: () => cycleTab(e.shiftKey ? -1 : 1),
    };
    if (actions[k]) {
      e.preventDefault();
      e.stopPropagation();
      actions[k]();
    }
  },
  true,
);

// ---- 預覽中的連結 ----
previewScroll.addEventListener('click', async (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (href.startsWith('#')) {
    const target = preview.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
    if (target) {
      scrollLeader = 'preview';
      target.scrollIntoView({ block: 'start' });
    }
    return;
  }
  if (/^(https?|mailto):/i.test(href)) {
    BrowserOpenURL(href);
    return;
  }
  // 相對路徑的 .md 連結：開成分頁
  const pathPart = decodeURIComponent(href.split('#')[0]);
  if (/\.(md|markdown|mdown|mkd)$/i.test(pathPart)) {
    const abs = await ResolvePath(pathPart);
    if (abs) openFile(abs);
  }
});

// ---- 拖放開檔 ----
const MARKDOWN = /\.(md|markdown|mdown|mkd|txt)$/i;
const canOpen = (p) => MARKDOWN.test(p) || IMPORTABLE.test(p) || UNSUPPORTED.test(p);
OnFileDrop(async (_x, _y, paths) => {
  if (modalOpen || !paths?.length) return;
  const unsupported = paths.filter((p) => !canOpen(p));
  for (const p of paths.filter(canOpen)) await openPath(p);
  if (unsupported.length) showError(t('unsupportedFile', { name: unsupported.map(fileName).join('、') }));
}, false);

// ---- 自動更新 ----
const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
let updateDismissed = false;
let updating = false;

// 右下角的更新卡片；buttons: [{ label, primary, run }]
function showUpdateToast({ title, notes = '', buttons = [], progress = null }) {
  $('mdb-update-title').textContent = title;
  $('mdb-update-notes').textContent = notes;
  $('mdb-update-notes').hidden = !notes;
  $('mdb-update-progress').hidden = progress === null;
  $('mdb-update-bar').style.width = `${progress ?? 0}%`;
  $('mdb-update-actions').replaceChildren(
    ...buttons.map((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      btn.className = b.primary ? 'primary' : '';
      btn.addEventListener('click', b.run);
      return btn;
    }),
  );
  $('mdb-update').hidden = false;
}

function hideUpdateToast() {
  $('mdb-update').hidden = true;
}

// 檢查新版本；離線或連不上 GitHub 時靜默略過
async function checkForUpdate() {
  if (updating || updateDismissed) return;
  let check;
  try {
    check = await CheckForUpdate();
  } catch {
    return;
  }
  if (!check?.available) return;
  const notes = check.latest.notes?.[getLanguage()] ?? check.latest.notes?.en ?? '';
  showUpdateToast({
    title: t('updateAvailable', { version: check.latest.version }),
    notes,
    buttons: [
      { label: t('btnUpdateNow'), primary: true, run: () => startUpdate(check) },
      {
        label: t('btnRemindLater'),
        run: () => {
          updateDismissed = true;
          hideUpdateToast();
        },
      },
    ],
  });
}

async function startUpdate(check) {
  if (modalOpen) return;
  // 更新會重新啟動程式：先確認每個未存檔的分頁
  for (const tab of [...tabs]) {
    if (!(await confirmDiscard(tab))) return;
  }
  updating = true;
  showUpdateToast({ title: t('updateDownloading', { version: check.latest.version }), progress: 0 });
  try {
    await ApplyUpdate(); // 成功時程式會自動重新啟動
  } catch (err) {
    updating = false;
    showUpdateToast({
      title: t('updateFailed'),
      notes: String(err?.message ?? err),
      buttons: [
        { label: t('btnRetry'), primary: true, run: () => startUpdate(check) },
        { label: t('btnClose'), run: hideUpdateToast },
      ],
    });
  }
}

EventsOn('update-progress', (pct) => {
  $('mdb-update-bar').style.width = `${pct}%`;
});

// ---- 其他執行個體轉交的檔案（程式已開啟時又雙擊 .md）----
EventsOn('open-files', async (paths) => {
  for (const path of paths ?? []) await openPath(path);
});

// ---- 關閉視窗：逐一詢問有未存變更的分頁 ----
EventsOn('close-requested', async () => {
  if (modalOpen) return;
  for (const tab of [...tabs]) {
    if (!(await confirmDiscard(tab))) return;
  }
  Quit();
});

// ---- 啟動 ----
async function init() {
  buildToolbar();
  settings = { ...settings, ...(await LoadSettings()) };
  const lang = settings.language || detectLanguage();
  $('mdb-language').value = lang;
  setLanguage(lang);
  applyToDom();
  setViewMode('split');

  addTab();
  for (const path of await GetStartupFiles()) await openPath(path);
  if (await WasUpdated()) {
    showUpdateToast({ title: t('updatedTo', { version: await GetVersion() }), buttons: [{ label: t('btnOk'), primary: true, run: hideUpdateToast }] });
    setTimeout(hideUpdateToast, 8000);
  }
  await refreshDefaultLink();
  await promptDefaultApp();
  setTimeout(checkForUpdate, 4000);
  setInterval(() => {
    updateDismissed = false; // 「稍後」只在這段期間內不再提示
    checkForUpdate();
  }, UPDATE_INTERVAL);
}

init();
