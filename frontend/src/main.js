import './style.css';
import {
  createElement,
  FilePlus, FolderOpen, Save, SaveAll,
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3,
  List, ListOrdered, ListTodo, TextQuote,
  Code, SquareCode, Link, Image, Table, Minus,
  PenLine, Columns2, Eye, Languages, Sigma, Plus, X, FileDown, FileText, FileOutput, Sun, Moon, Monitor,
} from 'lucide';
import {
  GetStartupFiles, LoadSettings, SaveSettings, OpenFileDialog, SaveFileDialog,
  ReadFile, SaveFile, SetDirty, SetDocPath, ResolvePath, Quit,
  ExportDialog, ExportPDF, WriteBase64File, OpenWithDefaultApp, ImportTargets,
  IsDefaultMarkdownApp, ShowDefaultAppDialog,
  CheckForUpdate, ApplyUpdate, WasUpdated, GetVersion, SetTitleBarDark,
} from '../wailsjs/go/main/App';
import { EventsOn, OnFileDrop, WindowSetTitle, BrowserOpenURL } from '../wailsjs/runtime/runtime';
import { t, setLanguage, getLanguage, detectLanguage, languages, applyToDom } from './i18n.js';
import { createEditor, commands, languageName } from './editor.js';
import { renderPreview, lineAnchors } from './preview.js';
import { buildHtml, buildDocx } from './export.js';
import { importDocument } from './importer.js';
import { kindOf, isEditorKind, CONVERTIBLE_EXT } from './kinds.js';
import { pdfViewer } from './viewers/pdf.js';
import { ebookViewer } from './viewers/ebook.js';
import { initSidebar } from './sidebar.js';
import { initSearch, focusSearch } from './search.js';
import { EditorView } from '@codemirror/view';

const $ = (id) => document.getElementById(id);
const workspace = $('mdb-workspace');
const previewScroll = $('mdb-preview-scroll');
const preview = $('mdb-preview');
const viewerHost = $('mdb-viewer');
const tabBar = $('mdb-tabs');

// ---- 分頁狀態 ----
// 每個分頁有類型（kind）：markdown / text 使用共用的編輯器，各自保存 EditorState（內容、游標、復原紀錄）；
// pdf / ebook 使用各自的閱讀器元件（viewers[kind]），切換分頁時隱藏 / 顯示。
// 作用中編輯器分頁的最新狀態永遠在 view.state，切換時才寫回 tab.state。
let tabs = [];
let active = null;
let tabSeq = 0;
let viewMode = 'split'; // Markdown 分頁的檢視模式
let settings = { language: '', defaultPrompt: '', theme: 'system' };

// 閱讀器（PDF、電子書）：{ open(tab, container, path, app), status(tab), destroy(tab), onActivate?(tab), onKey?(tab, e) }
const viewers = { pdf: pdfViewer, ebook: ebookViewer };

// 給側欄、AI 等模組訂閱的事件：active（切換分頁）、change（內容變動）、cursor、saved（存檔路徑）、language
const listeners = {};
function emit(event, ...args) {
  for (const fn of listeners[event] ?? []) {
    try {
      fn(...args);
    } catch (err) {
      console.error(err);
    }
  }
}

const editor = createEditor($('mdb-editor'), {
  onChange: () => {
    updateDirty();
    if (active?.kind === 'markdown') scheduleRender();
    emit('change', active);
  },
  onCursor: () => {
    updateStatusInfo();
    emit('cursor', active);
  },
});
const view = editor.view;

function fileName(path) {
  return path ? path.split(/[\\/]/).pop() : t('untitled');
}

// Windows 路徑不分大小寫，\ 與 / 視為相同
function samePath(a, b) {
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  return Boolean(a && b) && norm(a) === norm(b);
}

function updateTitle() {
  WindowSetTitle(`${fileName(active.path)}${active.dirty ? ' *' : ''} - ${t('appName')}`);
}

function syncGlobalDirty() {
  SetDirty(tabs.some((tab) => tab.dirty));
}

function updateDirty() {
  if (!isEditorKind(active?.kind)) return;
  const now = !view.state.doc.eq(active.savedDoc);
  if (now === active.dirty) return;
  active.dirty = now;
  syncGlobalDirty();
  updateTitle();
  renderTabs();
}

function updateStatusInfo() {
  if (!active) return;
  $('mdb-status-path').textContent = active.path || t('untitled');
  if (!isEditorKind(active.kind)) {
    $('mdb-status-info').textContent = viewers[active.kind]?.status(active) ?? '';
    return;
  }
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const type = active.kind === 'markdown' ? 'Markdown' : (languageName(active.path) ?? t('plainText'));
  $('mdb-status-info').textContent = [
    type,
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

function setBusy(message) {
  clearTimeout(messageTimer);
  $('mdb-status-message').textContent = message ?? '';
  document.body.classList.toggle('busy', Boolean(message));
}

// ---- 預覽（只有 Markdown 分頁）----
let renderTimer;
let anchorsCache = null;

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 120);
}

function render(sync = true) {
  clearTimeout(renderTimer);
  if (active?.kind !== 'markdown') return;
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

// ---- 同步捲動（Markdown 分割模式）----
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
  if (active?.kind !== 'markdown' || viewMode !== 'split') return;
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
      if (isEditorKind(active?.kind)) view.focus();
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
  await activate(tab);
  const answer = await showModal(t('unsavedTitle'), t('unsavedMessage', { name: fileName(tab.path) }), [
    { label: t('btnSave'), value: 'save', primary: true },
    { label: t('btnDiscard'), value: 'discard' },
    { label: t('btnCancel'), value: 'cancel' },
  ]);
  if (answer === 'save') return save();
  return answer === 'discard';
}

// ---- 分頁 ----
async function createTab(info, content) {
  const kind = info.kind ?? kindOf(info.path);
  const tab = {
    id: ++tabSeq,
    path: '',
    encoding: 'UTF-8',
    crlf: false,
    bom: false,
    ...info,
    kind,
    dirty: false,
    editorScroll: 0,
    previewScroll: 0,
  };
  if (isEditorKind(kind)) {
    tab.state = await editor.createState(content ?? '', kind, tab.path);
    tab.savedDoc = tab.state.doc;
  } else {
    tab.viewerEl = document.createElement('div');
    tab.viewerEl.className = 'viewer';
    tab.viewerEl.hidden = true;
    viewerHost.append(tab.viewerEl);
  }
  return tab;
}

// 空白、未命名、未修改的 Markdown 分頁：開檔時直接被取代
function isPristine(tab) {
  if (tab.kind !== 'markdown') return false;
  const doc = tab === active ? view.state.doc : tab.state.doc;
  return !tab.path && !tab.dirty && doc.length === 0;
}

// 依分頁類型切換版面與工具列可用狀態
function applyLayout() {
  const kind = active.kind;
  document.body.dataset.kind = kind;
  const mode = kind === 'markdown' ? viewMode : isEditorKind(kind) ? 'edit' : 'viewer';
  workspace.className = `workspace mode-${mode}`;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', kind === 'markdown' && b.dataset.view === viewMode));
  $('mdb-convert').hidden = !(active.path && CONVERTIBLE_EXT.test(active.path));
  for (const tab of tabs) if (tab.viewerEl) tab.viewerEl.hidden = tab !== active;
}

async function activate(tab) {
  if (tab === active) return;
  if (active && tabs.includes(active) && isEditorKind(active.kind)) {
    active.state = view.state;
    active.editorScroll = view.scrollDOM.scrollTop;
    active.previewScroll = previewScroll.scrollTop;
  }
  active = tab;
  applyLayout();
  SetDocPath(tab.path);
  updateTitle();
  renderTabs();
  if (isEditorKind(tab.kind)) {
    view.setState(tab.state);
    render(false);
    const { editorScroll, previewScroll: pvScroll } = tab;
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = editorScroll;
      previewScroll.scrollTop = pvScroll;
    });
    view.focus();
  } else {
    viewers[tab.kind]?.onActivate?.(tab);
  }
  updateStatusInfo();
  emit('active', tab);
}

async function addTab(info = {}, content = '') {
  const tab = await createTab(info, content);
  tabs.push(tab);
  await activate(tab);
  return tab;
}

async function removeTab(tab) {
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  tabs.splice(index, 1);
  if (tab.viewerEl) {
    tab.viewerEl.remove();
    try {
      viewers[tab.kind]?.destroy?.(tab);
    } catch (err) {
      console.error(err);
    }
  }
  if (!tabs.length) {
    await addTab();
  } else if (tab === active) {
    await activate(tabs[Math.min(index, tabs.length - 1)]);
  }
  syncGlobalDirty();
  renderTabs();
}

async function closeTab(tab = active) {
  if (!(await confirmDiscard(tab))) return false;
  await removeTab(tab);
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
    el.dataset.kind = tab.kind;
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
  return addTab();
}

// 開成新分頁；目前是空白分頁則取代它
async function openAsTab(info, content) {
  const reuse = active && isPristine(active) ? active : null;
  const tab = await addTab(info, content);
  if (reuse) await removeTab(reuse);
  return tab;
}

// 開啟檔案成為分頁；已開啟則切換過去；Word / Excel 等文件自動轉換；PDF、電子書用閱讀器開啟
async function openPath(path) {
  const existing = tabs.find((tab) => samePath(tab.path, path));
  if (existing) {
    await activate(existing);
    return;
  }
  const kind = kindOf(path);
  if (kind === 'unsupported') {
    await showError(t('unsupportedFormat', { name: fileName(path) }));
    return;
  }
  if (kind === 'office') {
    await importPath(path);
    return;
  }
  if (!isEditorKind(kind)) {
    if (!viewers[kind]) {
      await showError(t('unsupportedFile', { name: fileName(path) }));
      return;
    }
    const tab = await openAsTab({ path, kind });
    try {
      await viewers[kind].open(tab, tab.viewerEl, path, app);
    } catch (err) {
      await removeTab(tab);
      await showError(t('openFailed', { error: String(err?.message ?? err) }));
      return;
    }
    updateStatusInfo();
    emit('active', tab); // 閱讀器載入完成，大綱等可以更新
    return;
  }
  let d;
  try {
    d = await ReadFile(path);
  } catch (err) {
    const message = String(err?.message ?? err);
    await showError(message.includes('BINARY_FILE') ? t('notTextFile', { name: fileName(path) }) : t('openFailed', { error: message }));
    return;
  }
  await openAsTab({ path: d.path, encoding: d.encoding, crlf: d.crlf, bom: d.bom }, d.content);
}

// 轉換文件成 Markdown，開成未存檔的新分頁（預設存到原檔旁的「原檔名.md」）
async function importPath(path) {
  setBusy(t('importing'));
  let result;
  try {
    const target = await ImportTargets(path, tabs.map((tab) => tab.path).filter(Boolean));
    result = { path: target.markdownPath, markdown: await importDocument(path, target, { slide: t('slide') }) };
  } catch (err) {
    setBusy(null);
    await showError(t('importFailed', { name: fileName(path), error: String(err?.message ?? err) }));
    return;
  }
  setBusy(null);
  const tab = await openAsTab({ path: result.path, kind: 'markdown' }, result.markdown);
  // 尚未存檔：以空白內容當作「已存」基準，分頁會顯示未存檔
  tab.savedDoc = (await editor.createState('', 'markdown')).doc;
  tab.dirty = true;
  syncGlobalDirty();
  updateTitle();
  renderTabs();
  flashMessage(t('importedFrom', { name: fileName(path) }));
}

// 「轉為 Markdown」：PDF、HTML、CSV 分頁
function convertActive() {
  if (active.path && CONVERTIBLE_EXT.test(active.path)) importPath(active.path);
}

async function openFile(path) {
  const paths = path
    ? [path]
    : await OpenFileDialog(t('dialogOpenTitle'), t('supportedFiles'), t('markdownFiles'), t('allFiles'));
  for (const p of paths ?? []) await openPath(p);
}

async function writeTo(path) {
  const tab = active;
  // UTF-16 檔案存回 UTF-16；其他（含 Big5 開啟的檔案）一律存成 UTF-8
  const encoding = tab.encoding.startsWith('UTF-16') ? tab.encoding : 'UTF-8';
  try {
    await SaveFile(path, view.state.doc.toString(), tab.crlf, tab.bom, encoding);
  } catch (err) {
    await showError(t('saveFailed', { error: String(err) }));
    return false;
  }
  const pathChanged = path !== tab.path;
  tab.path = path;
  tab.encoding = encoding;
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
  emit('saved', path);
  return true;
}

async function save() {
  if (!isEditorKind(active.kind)) return true;
  return active.path ? writeTo(active.path) : saveAs();
}

async function saveAs() {
  if (!isEditorKind(active.kind)) return false;
  const defaultName = active.path ? fileName(active.path) : `${t('untitled')}.md`;
  const path = await SaveFileDialog(t('dialogSaveTitle'), defaultName, t('markdownFiles'), t('allFiles'));
  if (!path) return false;
  // 另存成另一個已開啟的檔案時，關掉那個舊分頁，避免同一檔案開兩次
  const duplicate = tabs.find((tab) => tab !== active && samePath(tab.path, path));
  const ok = await writeTo(path);
  if (ok && duplicate) await removeTab(duplicate);
  return ok;
}

// ---- 匯出 PDF / Word（Markdown 分頁）----
let exporting = false;

async function exportAs(kind) {
  if (exporting || active.kind !== 'markdown') return;
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
  setBusy(t('exporting'));
  let error = null;
  try {
    const source = view.state.doc.toString();
    if (kind === 'pdf') await ExportPDF(await buildHtml(source, base), path);
    else await WriteBase64File(path, await buildDocx(source, base));
  } catch (err) {
    error = err;
  } finally {
    exporting = false;
    setBusy(null);
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

// ---- 檢視模式（Markdown 分頁）----
function setViewMode(mode) {
  if (active.kind !== 'markdown') return;
  viewMode = mode;
  applyLayout();
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
  if (active.kind === 'markdown' && view.state.doc.length === 0) render();
  settings.language = code;
  SaveSettings(settings);
  emit('language', code);
}

// ---- 主題（跟隨系統 / 淺色 / 深色）----
const THEME_ORDER = ['system', 'light', 'dark'];
const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon };
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const setting = THEME_ORDER.includes(settings.theme) ? settings.theme : 'system';
  const resolved = setting === 'system' ? (systemDark.matches ? 'dark' : 'light') : setting;
  const changed = document.documentElement.dataset.theme !== resolved;
  document.documentElement.dataset.theme = resolved;
  SetTitleBarDark(resolved === 'dark'); // 視窗標題列跟著切換（Windows 10 需要強制重畫）
  const btn = $('mdb-theme');
  if (btn) {
    btn.replaceChildren(createElement(THEME_ICONS[setting], { width: 18, height: 18 }));
    btn.dataset.i18nTitle = `theme_${setting}_app`;
    btn.title = t(btn.dataset.i18nTitle);
  }
  if (changed && active?.kind === 'markdown') render(false); // 圖表依主題重新繪製
}

function cycleTheme() {
  const index = THEME_ORDER.indexOf(settings.theme);
  settings.theme = THEME_ORDER[(index + 1) % THEME_ORDER.length];
  applyTheme();
  SaveSettings(settings);
}

systemDark.addEventListener('change', applyTheme);

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
// role：file（永遠可用）、export / format / view（只有 Markdown 分頁可用）
const toolbarGroups = [
  {
    role: 'file',
    items: [
      { icon: FilePlus, key: 'newFile', run: newFile },
      { icon: FolderOpen, key: 'openFile', run: () => openFile() },
      { icon: Save, key: 'save', run: save },
      { icon: SaveAll, key: 'saveAs', run: saveAs },
    ],
  },
  {
    role: 'export',
    items: [
      { icon: FileDown, key: 'exportPdf', run: () => exportAs('pdf') },
      { icon: FileText, key: 'exportWord', run: () => exportAs('docx') },
    ],
  },
  {
    role: 'format',
    items: [
      { icon: Bold, key: 'bold' },
      { icon: Italic, key: 'italic' },
      { icon: Strikethrough, key: 'strike' },
      { icon: Heading1, key: 'h1' },
      { icon: Heading2, key: 'h2' },
      { icon: Heading3, key: 'h3' },
    ],
  },
  {
    role: 'format',
    items: [
      { icon: List, key: 'bulletList' },
      { icon: ListOrdered, key: 'orderedList' },
      { icon: ListTodo, key: 'taskList' },
      { icon: TextQuote, key: 'quote' },
    ],
  },
  {
    role: 'format',
    items: [
      { icon: Code, key: 'inlineCode' },
      { icon: SquareCode, key: 'codeBlock' },
      { icon: Link, key: 'link' },
      { icon: Image, key: 'image' },
      { icon: Table, key: 'table' },
      { icon: Minus, key: 'hr' },
      { icon: Sigma, key: 'math' },
    ],
  },
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
  for (const group of toolbarGroups) {
    const g = document.createElement('div');
    g.className = 'tool-group';
    g.dataset.role = group.role;
    for (const item of group.items) {
      g.append(
        iconButton(item.icon, item.key, () => {
          if (item.run) return item.run();
          if (active.kind !== 'markdown') return;
          if (viewMode === 'preview') setViewMode('split'); // 只預覽時按格式鈕，先切回可編輯
          commands[item.key](view);
        }),
      );
    }
    bar.append(g);
  }

  // 「轉為 Markdown」：只在 PDF / HTML / CSV 分頁顯示
  const convert = iconButton(FileOutput, 'convertToMarkdown', convertActive);
  convert.id = 'mdb-convert';
  convert.classList.add('tool-labeled');
  const label = document.createElement('span');
  label.dataset.i18n = 'convertToMarkdownShort';
  convert.append(label);
  convert.hidden = true;
  bar.append(convert);

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  bar.append(spacer);

  const modes = document.createElement('div');
  modes.className = 'tool-group segmented';
  modes.dataset.role = 'view';
  for (const [mode, icon, key] of [['edit', PenLine, 'viewEdit'], ['split', Columns2, 'viewSplit'], ['preview', Eye, 'viewPreview']]) {
    const btn = iconButton(icon, key, () => setViewMode(mode));
    btn.dataset.view = mode;
    modes.append(btn);
  }
  bar.append(modes);

  const theme = iconButton(Monitor, 'theme_system_app', cycleTheme);
  theme.id = 'mdb-theme';
  theme.classList.add('theme-toggle');
  bar.append(theme);

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
    // 閱讀器分頁的快捷鍵（搜尋、縮放）
    if (active && !isEditorKind(active.kind) && viewers[active.kind]?.onKey?.(active, e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!ctrl || e.altKey) return;
    const actions = {
      n: newFile,
      o: () => openFile(),
      s: e.shiftKey ? saveAs : save,
      w: () => closeTab(),
      f: e.shiftKey ? focusSearch : null, // Ctrl+F 交給編輯器 / 閱讀器，Ctrl+Shift+F 全文搜尋
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
  // 相對路徑的檔案連結：開成分頁
  const pathPart = decodeURIComponent(href.split('#')[0]);
  if (pathPart) {
    const abs = await ResolvePath(pathPart);
    if (abs) openFile(abs);
  }
});

// ---- 拖放開檔（任何檔案；不是文字檔時會提示）----
OnFileDrop(async (_x, _y, paths) => {
  if (modalOpen || !paths?.length) return;
  for (const p of paths) await openPath(p);
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

// ---- 其他執行個體轉交的檔案（程式已開啟時又雙擊檔案）----
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

// ---- 給其他模組（閱讀器、側欄、AI）使用的介面 ----
export const app = {
  get tabs() {
    return tabs;
  },
  get active() {
    return active;
  },
  view,
  editor,
  viewers,
  t,
  on(event, fn) {
    (listeners[event] ??= []).push(fn);
  },
  // 選取編輯器中的範圍並捲到畫面中間
  selectRange(from, to) {
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    view.focus();
  },
  // 編輯器跳到指定行（1 起算）並捲到上方
  gotoLine(n) {
    if (!isEditorKind(active.kind)) return;
    const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 12 }) });
    view.focus();
  },
  fileName,
  openPath,
  openFile,
  openAsTab,
  activate,
  updateStatusInfo,
  flashMessage,
  setBusy,
  showModal,
  showError,
  // 取得任一編輯器分頁目前的文字（作用中的分頁以 view.state 為準）
  textOf(tab) {
    if (!isEditorKind(tab.kind)) return null;
    return (tab === active ? view.state.doc : tab.state.doc).toString();
  },
};

// ---- 啟動 ----
async function init() {
  buildToolbar();
  settings = { ...settings, ...(await LoadSettings()) };
  const lang = settings.language || detectLanguage();
  $('mdb-language').value = lang;
  setLanguage(lang);
  applyToDom();
  applyTheme();

  await addTab();
  initSearch(app);
  await initSidebar(app);
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
