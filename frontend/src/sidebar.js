// 左側活動列與側欄：檔案總管、大綱（之後的全文搜尋也註冊在這裡）。
import {
  createElement, Files, ListTree, FolderOpen, RefreshCw, ChevronsDownUp, FolderX,
  ChevronRight, ChevronDown, Folder, FileText, FileCode, FileImage, BookOpen, File, FileType, FileSpreadsheet,
} from 'lucide';
import { OpenFolderDialog, ListDir, PathExists, LoadState, SaveState } from '../wailsjs/go/main/App';
import { t, applyToDom } from './i18n.js';
import { kindOf } from './kinds.js';
import { languageName } from './editor.js';

const $ = (id) => document.getElementById(id);
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|svg|ico)$/i;
const MIN_WIDTH = 170;
const MAX_WIDTH = 640;

let app = null;
const panels = {};
const order = [];
let layout = { panel: 'explorer', open: false, width: 260 };

const norm = (p) => (p ?? '').replace(/\\/g, '/').toLowerCase();

function saveLayout() {
  SaveState('sidebar', JSON.stringify(layout));
}

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

// ---- 活動列與側欄框架 ----
export function registerPanel(id, panel) {
  panels[id] = panel;
  order.push(id);
}

function renderActivityBar() {
  const bar = $('mdb-activity');
  bar.replaceChildren(
    ...order.map((id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'activity-item' + (layout.open && layout.panel === id ? ' active' : '');
      b.dataset.i18nTitle = panels[id].titleKey;
      b.title = t(panels[id].titleKey);
      b.dataset.panel = id;
      b.append(createElement(panels[id].icon, { width: 22, height: 22, 'stroke-width': 1.7 }));
      b.addEventListener('click', () => togglePanel(id));
      return b;
    }),
  );
}

export function togglePanel(id, forceOpen = false) {
  if (!forceOpen && layout.open && layout.panel === id) layout.open = false;
  else {
    layout.open = true;
    layout.panel = id;
  }
  saveLayout();
  applyLayout();
}

export function refreshPanel(id) {
  if (layout.open && layout.panel === id) renderPanel();
}

function applyLayout() {
  $('mdb-side').hidden = !layout.open;
  $('mdb-side-resizer').hidden = !layout.open;
  document.querySelector('.app-body').style.setProperty('--side-width', `${layout.width}px`);
  renderActivityBar();
  if (layout.open) renderPanel();
}

async function renderPanel() {
  const panel = panels[layout.panel];
  $('mdb-side-title').textContent = t(panel.titleKey);
  $('mdb-side-actions').replaceChildren(...(panel.actions?.() ?? []));
  await panel.render($('mdb-side-content'));
}

function initResizer() {
  const handle = $('mdb-side-resizer');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = layout.width;
    const move = (ev) => {
      layout.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + ev.clientX - startX));
      document.querySelector('.app-body').style.setProperty('--side-width', `${layout.width}px`);
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

// ---- 檔案總管 ----
// 目前開啟的資料夾（給全文搜尋使用）
export function explorerRoot() {
  return explorer.root;
}

const explorer = {
  root: null,
  expanded: new Set(), // 展開中的資料夾（正規化路徑）
  cache: new Map(), // 資料夾（正規化路徑）→ 內容
};

function saveExplorer() {
  SaveState('explorer', JSON.stringify({ root: explorer.root, expanded: [...explorer.expanded] }));
}

function fileIcon(path) {
  if (IMAGE_EXT.test(path)) return FileImage;
  switch (kindOf(path)) {
    case 'markdown':
      return FileText;
    case 'pdf':
      return FileType;
    case 'ebook':
      return BookOpen;
    case 'office':
      return FileSpreadsheet;
    default:
      return languageName(path) ? FileCode : File;
  }
}

async function listDir(dir) {
  const key = norm(dir);
  if (!explorer.cache.has(key)) {
    try {
      explorer.cache.set(key, await ListDir(dir));
    } catch {
      explorer.cache.set(key, []);
    }
  }
  return explorer.cache.get(key);
}

async function openFolder() {
  const dir = await OpenFolderDialog(t('openFolder'));
  if (!dir) return;
  explorer.root = dir;
  explorer.expanded = new Set();
  explorer.cache.clear();
  saveExplorer();
  togglePanel('explorer', true);
}

function closeFolder() {
  explorer.root = null;
  explorer.expanded.clear();
  explorer.cache.clear();
  saveExplorer();
  refreshPanel('explorer');
}

function refreshExplorer() {
  explorer.cache.clear();
  refreshPanel('explorer');
}

function collapseAll() {
  explorer.expanded.clear();
  saveExplorer();
  refreshPanel('explorer');
}

function treeItem(entry, depth) {
  const item = document.createElement('div');
  item.className = 'tree-item' + (entry.isDir ? ' tree-dir' : '');
  item.style.paddingLeft = `${8 + depth * 14}px`;
  item.dataset.path = norm(entry.path);
  item.title = entry.path;
  const open = entry.isDir && explorer.expanded.has(norm(entry.path));
  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron';
  if (entry.isDir) chevron.append(createElement(open ? ChevronDown : ChevronRight, { width: 14, height: 14 }));
  const icon = createElement(entry.isDir ? (open ? FolderOpen : Folder) : fileIcon(entry.name), { width: 15, height: 15 });
  icon.classList.add('tree-icon');
  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = entry.name;
  item.append(chevron, icon, name);
  item.addEventListener('click', () => {
    if (entry.isDir) {
      const key = norm(entry.path);
      if (explorer.expanded.has(key)) explorer.expanded.delete(key);
      else explorer.expanded.add(key);
      saveExplorer();
      refreshPanel('explorer');
    } else {
      app.openPath(entry.path);
    }
  });
  return item;
}

async function buildTree(dir, depth, out) {
  for (const entry of await listDir(dir)) {
    out.push(treeItem(entry, depth));
    if (entry.isDir && explorer.expanded.has(norm(entry.path))) await buildTree(entry.path, depth + 1, out);
  }
}

function markActiveFile() {
  const current = norm(app.active?.path);
  for (const el of document.querySelectorAll('#mdb-side-content .tree-item')) {
    el.classList.toggle('current', Boolean(current) && el.dataset.path === current);
  }
}

registerPanel('explorer', {
  icon: Files,
  titleKey: 'explorer',
  actions() {
    if (!explorer.root) return [iconButton(FolderOpen, 'openFolder', openFolder)];
    return [
      iconButton(FolderOpen, 'openFolder', openFolder),
      iconButton(RefreshCw, 'refresh', refreshExplorer),
      iconButton(ChevronsDownUp, 'collapseAll', collapseAll),
      iconButton(FolderX, 'closeFolder', closeFolder),
    ];
  },
  async render(content) {
    if (!explorer.root) {
      const empty = document.createElement('div');
      empty.className = 'side-empty';
      const p = document.createElement('p');
      p.textContent = t('noFolderOpen');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'side-primary';
      b.textContent = t('openFolder');
      b.addEventListener('click', openFolder);
      empty.append(p, b);
      content.replaceChildren(empty);
      return;
    }
    const rootName = explorer.root.split(/[\\/]/).filter(Boolean).pop() ?? explorer.root;
    const header = document.createElement('div');
    header.className = 'tree-root';
    header.textContent = rootName;
    header.title = explorer.root;
    const items = [];
    await buildTree(explorer.root, 0, items);
    const tree = document.createElement('div');
    tree.className = 'tree';
    tree.append(...items);
    content.replaceChildren(header, tree);
    markActiveFile();
  },
  onActive: markActiveFile,
  onSaved(path) {
    // 存檔的檔案在開啟的資料夾內：重新讀取該資料夾（新檔案才會出現）
    if (explorer.root && norm(path).startsWith(norm(explorer.root))) {
      explorer.cache.delete(norm(path.replace(/[\\/][^\\/]*$/, '')));
      refreshPanel('explorer');
    }
  },
});

// ---- 大綱 ----
// 程式碼的函式 / 類別（常見語言的寫法；以縮排決定層級）
const SYMBOL_RULES = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+|sealed\s+|static\s+|public\s+|private\s+|internal\s+|partial\s+)*(?:class|interface|struct|enum|record)\s+([A-Za-z_$][\w$]*)/, type: 'class' },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$-]*)/, type: 'fn' },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, type: 'fn' },
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, type: 'fn' },
  { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, type: 'fn' },
  { re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, type: 'class' },
  { re: /^\s*(?:(?:public|private|protected|internal|static|override|virtual|async|final|abstract|synchronized)\s+)+[\w<>[\],.?\s]+?\s+([A-Za-z_]\w*)\s*\([^;]*$/, type: 'fn' },
];

function codeSymbols(text) {
  const items = [];
  text.split('\n').forEach((line, i) => {
    for (const rule of SYMBOL_RULES) {
      const m = line.match(rule.re);
      if (m) {
        const indent = line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
        items.push({ label: m[1], type: rule.type, level: Math.min(4, Math.floor(indent / 4)), line: i + 1 });
        break;
      }
    }
  });
  return items;
}

// Markdown 標題（略過程式碼區塊內的 #）
function markdownHeadings(text) {
  const items = [];
  let fence = null;
  text.split('\n').forEach((line, i) => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) items.push({ label: m[2], level: m[1].length - 1, line: i + 1 });
  });
  return items;
}

async function outlineItems(tab) {
  if (!tab) return [];
  if (tab.kind === 'markdown') return markdownHeadings(app.textOf(tab));
  if (tab.kind === 'text') return codeSymbols(app.textOf(tab));
  return (await app.viewers[tab.kind]?.outline?.(tab)) ?? [];
}

function markCurrentHeading() {
  const tab = app.active;
  if (tab?.kind !== 'markdown' && tab?.kind !== 'text') return;
  const line = app.view.state.doc.lineAt(app.view.state.selection.main.head).number;
  const items = [...document.querySelectorAll('#mdb-side-content .outline-item[data-line]')];
  let current = null;
  for (const el of items) if (Number(el.dataset.line) <= line) current = el;
  for (const el of items) el.classList.toggle('current', el === current);
}

let outlineTimer = null;
registerPanel('outline', {
  icon: ListTree,
  titleKey: 'outline',
  async render(content) {
    const tab = app.active;
    const items = await outlineItems(tab);
    if (tab !== app.active) return; // 期間切換了分頁
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'side-empty-text';
      p.textContent = t('outlineEmpty');
      content.replaceChildren(p);
      return;
    }
    content.replaceChildren(
      ...items.map((item) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'outline-item';
        b.style.paddingLeft = `${10 + item.level * 14}px`;
        if (item.type) b.dataset.type = item.type;
        if (item.line) b.dataset.line = item.line;
        b.textContent = item.label;
        b.title = item.label;
        b.addEventListener('click', () => (item.line ? app.gotoLine(item.line) : item.go?.()));
        return b;
      }),
    );
    markCurrentHeading();
  },
  onActive: () => refreshPanel('outline'),
  onChange() {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(() => refreshPanel('outline'), 400);
  },
  onCursor: markCurrentHeading,
});

// ---- 初始化 ----
export async function initSidebar(appApi) {
  app = appApi;
  try {
    layout = { ...layout, ...JSON.parse((await LoadState('sidebar')) || '{}') };
  } catch {
    /* 使用預設 */
  }
  if (!panels[layout.panel]) layout.panel = order[0];
  try {
    const saved = JSON.parse((await LoadState('explorer')) || '{}');
    if (saved.root && (await PathExists(saved.root))) {
      explorer.root = saved.root;
      explorer.expanded = new Set(saved.expanded ?? []);
    }
  } catch {
    /* 沒有上次的資料夾 */
  }
  initResizer();
  const forward = (hook) => (...args) => {
    if (!layout.open) return;
    panels[layout.panel]?.[hook]?.(...args);
  };
  app.on('active', forward('onActive'));
  app.on('change', forward('onChange'));
  app.on('cursor', forward('onCursor'));
  app.on('saved', (path) => panels.explorer.onSaved(path));
  app.on('language', () => {
    renderActivityBar();
    if (layout.open) renderPanel();
  });
  applyLayout();
  applyToDom($('mdb-side'));
}
