// 側欄「搜尋」面板：搜尋所有開啟的分頁（以目前內容為準）＋檔案總管開啟的資料夾。
import { createElement, Search, ChevronRight, ChevronDown } from 'lucide';
import { SearchFolder } from '../wailsjs/go/main/App';
import { t } from './i18n.js';
import { registerPanel, refreshPanel, togglePanel, explorerRoot } from './sidebar.js';

const MAX_RESULTS = 2000;
let app = null;
const state = {
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  result: null, // { files: [{ path, name, tab?, matches: [{ line, column, length, text, utf16? }] }], total, truncated, error }
  collapsed: new Set(),
  running: 0,
};

const norm = (p) => (p ?? '').replace(/\\/g, '/').toLowerCase();

function buildRegExp() {
  let pattern = state.regex ? state.query : state.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (state.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  return new RegExp(pattern, state.caseSensitive ? 'g' : 'gi');
}

// 開啟中的編輯器分頁：以目前內容搜尋（含未存檔的修改）
function searchTabs(re, limit) {
  const files = [];
  let total = 0;
  for (const tab of app.tabs) {
    const text = app.textOf(tab);
    if (text == null) continue;
    const matches = [];
    text.split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) && total < limit) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        matches.push({ line: i + 1, column: m.index, length: m[0].length, text: line.slice(0, 240), utf16: true });
        total++;
      }
    });
    if (matches.length) files.push({ path: tab.path, name: app.fileName(tab.path), tab, matches });
  }
  return { files, total };
}

async function runSearch() {
  const run = ++state.running;
  if (!state.query) {
    state.result = null;
    refreshPanel('search');
    return;
  }
  let re;
  try {
    re = buildRegExp();
  } catch (err) {
    state.result = { files: [], total: 0, error: t('regexError', { error: err.message }) };
    refreshPanel('search');
    return;
  }
  const fromTabs = searchTabs(re, MAX_RESULTS);
  let result = { files: fromTabs.files, total: fromTabs.total, truncated: fromTabs.total >= MAX_RESULTS };
  const root = explorerRoot();
  if (root && !result.truncated) {
    try {
      const skip = app.tabs.filter((tab) => tab.path && app.textOf(tab) != null).map((tab) => tab.path);
      const folder = await SearchFolder(
        root,
        { query: state.query, caseSensitive: state.caseSensitive, wholeWord: state.wholeWord, regex: state.regex, maxResults: MAX_RESULTS - result.total },
        skip,
      );
      if (run !== state.running) return;
      result.files.push(...folder.files.map((f) => ({ ...f, name: app.fileName(f.path) })));
      result.total += folder.total;
      result.truncated = result.truncated || folder.truncated;
    } catch (err) {
      result.error = t('regexError', { error: String(err?.message ?? err) });
    }
  }
  if (run !== state.running) return;
  state.result = result;
  state.collapsed.clear();
  refreshPanel('search');
}

// Go 回傳的欄位以 Unicode 字元計算，轉成編輯器使用的 UTF-16 位置
function runeToUtf16(text, runeIndex) {
  let units = 0;
  let count = 0;
  for (const ch of text) {
    if (count++ >= runeIndex) break;
    units += ch.length;
  }
  return units;
}

async function openMatch(file, match) {
  if (file.tab && app.tabs.includes(file.tab)) await app.activate(file.tab);
  else await app.openPath(file.path);
  const line = app.view.state.doc.line(Math.min(match.line, app.view.state.doc.lines));
  const from = match.utf16 ? match.column : runeToUtf16(line.text, match.column);
  const to = match.utf16 ? from + match.length : runeToUtf16(line.text, match.column + match.length);
  app.selectRange(line.from + from, line.from + to);
}

function highlight(text, match) {
  const span = document.createElement('span');
  span.className = 'search-line';
  const start = match.utf16 ? match.column : runeToUtf16(text, match.column);
  const end = match.utf16 ? start + match.length : runeToUtf16(text, match.column + match.length);
  // 太長的行：從符合處前面一點開始顯示
  const from = Math.max(0, start - 30);
  const mark = document.createElement('mark');
  mark.textContent = text.slice(start, end);
  span.append((from > 0 ? '…' : '') + text.slice(from, start).trimStart(), mark, text.slice(end));
  return span;
}

function toggleButton(label, key, titleKey) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'search-option' + (state[key] ? ' on' : '');
  b.textContent = label;
  b.title = t(titleKey);
  b.setAttribute('aria-pressed', String(state[key]));
  b.addEventListener('click', () => {
    state[key] = !state[key];
    runSearch();
  });
  return b;
}

let inputTimer = null;

registerPanel('search', {
  icon: Search,
  titleKey: 'searchPanel',
  render(content) {
    const box = document.createElement('div');
    box.className = 'search-box';
    const input = document.createElement('input');
    input.type = 'search';
    input.id = 'mdb-search-input';
    input.placeholder = t('searchPlaceholder');
    input.value = state.query;
    input.addEventListener('input', () => {
      state.query = input.value;
      clearTimeout(inputTimer);
      inputTimer = setTimeout(runSearch, 400);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(inputTimer);
        state.query = input.value;
        runSearch();
      }
    });
    box.append(input, toggleButton('Aa', 'caseSensitive', 'matchCase'), toggleButton('ab', 'wholeWord', 'wholeWord'), toggleButton('.*', 'regex', 'useRegex'));

    const summary = document.createElement('div');
    summary.className = 'search-summary';
    const results = document.createElement('div');
    results.className = 'search-results';
    const r = state.result;
    if (r?.error) {
      summary.classList.add('error');
      summary.textContent = r.error;
    } else if (r) {
      summary.textContent = r.total
        ? t('searchSummary', { total: r.total, files: r.files.length }) + (r.truncated ? ` ${t('searchTruncated', { max: MAX_RESULTS })}` : '')
        : t('findNoResult');
      if (!explorerRoot()) summary.textContent += ` ${t('searchTabsOnly')}`;
      for (const file of r.files) {
        const key = norm(file.path) || String(file.tab?.id);
        const collapsed = state.collapsed.has(key);
        const head = document.createElement('div');
        head.className = 'search-file';
        head.title = file.path || file.name;
        const chevron = createElement(collapsed ? ChevronRight : ChevronDown, { width: 14, height: 14 });
        const name = document.createElement('span');
        name.className = 'search-file-name';
        name.textContent = file.name;
        const dir = document.createElement('span');
        dir.className = 'search-file-dir';
        dir.textContent = file.path ? file.path.replace(/[\\/][^\\/]*$/, '') : '';
        const count = document.createElement('span');
        count.className = 'search-count';
        count.textContent = file.matches.length;
        head.append(chevron, name, dir, count);
        head.addEventListener('click', () => {
          if (collapsed) state.collapsed.delete(key);
          else state.collapsed.add(key);
          refreshPanel('search');
        });
        results.append(head);
        if (collapsed) continue;
        for (const match of file.matches) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'search-match';
          const line = document.createElement('span');
          line.className = 'search-line-no';
          line.textContent = match.line;
          item.append(line, highlight(match.text, match));
          item.addEventListener('click', () => openMatch(file, match));
          results.append(item);
        }
      }
    }
    content.replaceChildren(box, summary, results);
  },
});

export function initSearch(appApi) {
  app = appApi;
}

// Ctrl+Shift+F：開啟搜尋面板並聚焦輸入框（有選取文字時帶入）
export function focusSearch() {
  const selection = app.view.state.sliceDoc(app.view.state.selection.main.from, app.view.state.selection.main.to);
  const fromSelection = selection && !selection.includes('\n') && selection !== state.query;
  if (fromSelection) state.query = selection;
  togglePanel('search', true);
  if (fromSelection) runSearch();
  setTimeout(() => {
    const input = document.getElementById('mdb-search-input');
    input?.focus();
    input?.select();
  }, 0);
}
