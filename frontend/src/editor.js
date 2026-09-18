import { EditorView, basicSetup } from 'codemirror';
import { EditorState, EditorSelection } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting, LanguageDescription } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { t } from './i18n.js';

// ---- 格式化指令 ----

// 以 before/after 包住選取文字；已包住則取消；沒選取時插入佔位文字並選取它。
function wrap(view, before, after, placeholderKey = 'placeholderText') {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const outerFrom = range.from - before.length;
    const outerTo = range.to + after.length;
    if (
      outerFrom >= 0 &&
      state.sliceDoc(outerFrom, range.from) === before &&
      state.sliceDoc(range.to, outerTo) === after
    ) {
      return {
        changes: [
          { from: outerFrom, to: range.from, insert: '' },
          { from: range.to, to: outerTo, insert: '' },
        ],
        range: EditorSelection.range(outerFrom, range.to - before.length),
      };
    }
    if (text.length > before.length + after.length && text.startsWith(before) && text.endsWith(after)) {
      const inner = text.slice(before.length, text.length - after.length);
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      };
    }
    const content = text || t(placeholderKey);
    return {
      changes: { from: range.from, to: range.to, insert: before + content + after },
      range: EditorSelection.range(range.from + before.length, range.from + before.length + content.length),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
  view.focus();
  return true;
}

const PREFIX_RE = {
  heading: /^(\s*)(#{1,6} )?/,
  list: /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] |> )?/,
};

function selectedLines(state) {
  const lines = new Set();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  const result = [...lines].sort((a, b) => a - b).map((n) => state.doc.line(n));
  // 多行選取時略過空白行
  return result.length > 1 ? result.filter((l) => l.text.trim() !== '') : result;
}

// 在選取的每一行前面加上前綴（取代既有的清單 / 標題前綴）；全部都已是同一種前綴時則移除。
// kind: 'heading' | 'list' | 'ordered'；prefixFor(i) 讓編號清單依序產生 1. 2. 3.
function toggleLinePrefix(view, kind, prefixFor) {
  const { state } = view;
  const re = PREFIX_RE[kind === 'heading' ? 'heading' : 'list'];
  const lines = selectedLines(state);
  const matches = lines.map((l) => l.text.match(re));
  const same = (m, i) =>
    m[2] !== undefined && (kind === 'ordered' ? /^\d+[.)] $/.test(m[2]) : m[2] === prefixFor(i));
  const remove = matches.every(same);
  const changes = lines.map((line, i) => {
    const m = matches[i];
    const from = line.from + m[1].length;
    const to = from + (m[2]?.length ?? 0);
    return { from, to, insert: remove ? '' : prefixFor(i) };
  });
  view.dispatch({ changes, scrollIntoView: true, userEvent: 'input' });
  view.focus();
  return true;
}

function heading(level) {
  const prefix = '#'.repeat(level) + ' ';
  return (view) => toggleLinePrefix(view, 'heading', () => prefix);
}

// 在游標處插入一段獨立的區塊（前後補空行），並選取 selectFrom..selectTo（相對於 block）。
function insertBlock(view, block, selectFrom = block.length, selectTo = selectFrom) {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  let pos = range.from;
  let prefix = '';
  if (line.text.trim() !== '') {
    pos = state.doc.lineAt(range.to).to;
    prefix = '\n\n';
  } else if (line.number > 1 && state.doc.line(line.number - 1).text.trim() !== '') {
    prefix = '\n';
  }
  const next = pos < state.doc.length ? state.sliceDoc(pos, pos + 2) : '';
  const suffix = next.startsWith('\n\n') || pos === state.doc.length ? '\n' : '\n\n';
  const insert = prefix + block + suffix;
  const base = pos + prefix.length;
  view.dispatch({
    changes: { from: pos, insert },
    selection: EditorSelection.range(base + selectFrom, base + selectTo),
    scrollIntoView: true,
    userEvent: 'input',
  });
  view.focus();
  return true;
}

export const commands = {
  bold: (v) => wrap(v, '**', '**'),
  italic: (v) => wrap(v, '*', '*'),
  strike: (v) => wrap(v, '~~', '~~'),
  inlineCode: (v) => wrap(v, '`', '`', 'placeholderCode'),
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  bulletList: (v) => toggleLinePrefix(v, 'list', () => '- '),
  orderedList: (v) => toggleLinePrefix(v, 'ordered', (i) => `${i + 1}. `),
  taskList: (v) => toggleLinePrefix(v, 'list', () => '- [ ] '),
  quote: (v) => toggleLinePrefix(v, 'list', () => '> '),
  codeBlock: (v) => {
    const sel = v.state.selection.main;
    if (!sel.empty) {
      const from = v.state.doc.lineAt(sel.from).from;
      const to = v.state.doc.lineAt(sel.to).to;
      const body = v.state.sliceDoc(from, to);
      v.dispatch({
        changes: { from, to, insert: '```\n' + body + '\n```' },
        selection: EditorSelection.cursor(from + 3),
        userEvent: 'input',
      });
      v.focus();
      return true;
    }
    const code = t('placeholderCode');
    return insertBlock(v, '```\n' + code + '\n```', 4, 4 + code.length);
  },
  link: (v) => {
    const sel = v.state.selection.main;
    const text = v.state.sliceDoc(sel.from, sel.to) || t('placeholderLink');
    const insert = `[${text}](https://)`;
    const urlFrom = sel.from + text.length + 3;
    v.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: EditorSelection.range(urlFrom, urlFrom + 8),
      scrollIntoView: true,
      userEvent: 'input',
    });
    v.focus();
    return true;
  },
  image: (v) => {
    const sel = v.state.selection.main;
    const alt = v.state.sliceDoc(sel.from, sel.to) || t('placeholderImage');
    const insert = `![${alt}](images/)`;
    const pathFrom = sel.from + alt.length + 4;
    v.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: EditorSelection.range(pathFrom, pathFrom + 7),
      scrollIntoView: true,
      userEvent: 'input',
    });
    v.focus();
    return true;
  },
  table: (v) => {
    const h = t('tableHeader');
    const c = t('tableCell');
    const table = [
      `| ${h} 1 | ${h} 2 | ${h} 3 |`,
      '| --- | --- | --- |',
      `| ${c} | ${c} | ${c} |`,
      `| ${c} | ${c} | ${c} |`,
    ].join('\n');
    return insertBlock(v, table, 2, 2 + h.length + 2);
  },
  hr: (v) => insertBlock(v, '---'),
  math: (v) => insertBlock(v, '$$\nE = mc^2\n$$', 3, 11),
};

const formatKeymap = keymap.of([
  { key: 'Mod-b', run: commands.bold },
  { key: 'Mod-i', run: commands.italic },
  { key: 'Mod-Shift-x', run: commands.strike },
  { key: 'Mod-e', run: commands.inlineCode },
  { key: 'Mod-Shift-e', run: commands.codeBlock },
  { key: 'Mod-k', run: commands.link },
  { key: 'Mod-1', run: commands.h1 },
  { key: 'Mod-2', run: commands.h2 },
  { key: 'Mod-3', run: commands.h3 },
  indentWithTab,
]);

// 非 Markdown 文件只保留 Tab 縮排，不套用 Markdown 格式快捷鍵
const indentKeymap = keymap.of([indentWithTab]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '15px' },
  '.cm-scroller': {
    fontFamily: 'Consolas, "Cascadia Mono", "Microsoft JhengHei UI", "Microsoft JhengHei", monospace',
    lineHeight: '1.65',
  },
  '.cm-content': { padding: '16px 0 40vh', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 20px 0 12px' },
  '.cm-gutters': { background: 'var(--gutter-bg)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLineGutter': { background: 'var(--active-line)' },
  '.cm-activeLine': { background: 'var(--active-line)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    background: 'var(--selection) !important',
  },
  '.cm-panels': { background: 'var(--toolbar-bg)', color: 'var(--text)' },
  '.cm-panels input, .cm-panels button': { color: 'var(--text)' },
  '.cm-searchMatch': { background: 'var(--mark-bg)' },
  '.cm-tooltip': { background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)' },
});

// 編輯區的語法上色（取代預設樣式：標題不加底線、標記符號用淡色）
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold', color: 'var(--hl-heading)' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--hl-link)' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--hl-meta)' },
  { tag: tags.quote, color: 'var(--hl-quote)' },
  { tag: tags.monospace, color: 'var(--hl-mono)' },
  // 程式碼區塊內
  { tag: tags.keyword, color: 'var(--hl-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--hl-string)' },
  { tag: tags.comment, color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--hl-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--hl-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--hl-type)' },
  { tag: [tags.tagName, tags.propertyName, tags.attributeName], color: 'var(--hl-tag)' },
]);

// 依檔名找出程式語言（找不到代表純文字）
function languageOf(path) {
  const name = (path || '').split(/[\\/]/).pop();
  return name ? LanguageDescription.matchFilename(languages, name) : null;
}

// 狀態列顯示用的檔案類型名稱；null 代表純文字
export function languageName(path) {
  return languageOf(path)?.name ?? null;
}

// 建立編輯器。onChange 在內容變動時呼叫；onCursor 在游標移動時呼叫。
export function createEditor(parent, { onChange, onCursor }) {
  const common = [
    basicSetup,
    theme,
    syntaxHighlighting(highlight),
    // 拖進來的是檔案時不要插入內容，讓事件往上交給 Wails 開檔
    EditorView.domEventHandlers({
      drop: (e) => e.dataTransfer?.types.includes('Files'),
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange();
      if (u.selectionSet || u.docChanged) onCursor();
    }),
  ];
  const markdownExtensions = [formatKeymap, ...common, markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping];
  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: markdownExtensions }) });
  return {
    view,
    // 為新分頁建立獨立的編輯狀態（內容、游標、復原紀錄）。
    // Markdown：格式快捷鍵＋自動換行；程式碼：依副檔名上色、不換行；純文字：自動換行。
    async createState(content, kind, path) {
      if (kind === 'markdown') return EditorState.create({ doc: content, extensions: markdownExtensions });
      const desc = languageOf(path);
      let language = [];
      if (desc) {
        try {
          language = await desc.load();
        } catch {
          /* 語言模組載入失敗時當純文字 */
        }
      }
      return EditorState.create({ doc: content, extensions: [indentKeymap, ...common, language, desc ? [] : EditorView.lineWrapping] });
    },
  };
}
