import { EditorView, basicSetup } from 'codemirror';
import { EditorState, EditorSelection } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
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

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '15px' },
  '.cm-scroller': {
    fontFamily: 'Consolas, "Cascadia Mono", "Microsoft JhengHei UI", "Microsoft JhengHei", monospace',
    lineHeight: '1.65',
  },
  '.cm-content': { padding: '16px 0 40vh' },
  '.cm-line': { padding: '0 20px 0 12px' },
  '.cm-gutters': { background: 'var(--gutter-bg)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLineGutter': { background: 'var(--active-line)' },
  '.cm-activeLine': { background: 'var(--active-line)' },
});

// 編輯區的語法上色（取代預設樣式：標題不加底線、標記符號用淡色）
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold', color: '#0b3d91' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: '#2f6fdb' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: '#8c959f' },
  { tag: tags.quote, color: '#57606a' },
  { tag: tags.monospace, color: '#953800' },
  // 程式碼區塊內
  { tag: tags.keyword, color: '#cf222e' },
  { tag: [tags.string, tags.special(tags.string)], color: '#0a3069' },
  { tag: tags.comment, color: '#6e7781', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#0550ae' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#8250df' },
  { tag: [tags.typeName, tags.className], color: '#953800' },
  { tag: [tags.tagName, tags.propertyName, tags.attributeName], color: '#116329' },
]);

// 建立編輯器。onChange 在內容變動時呼叫；onCursor 在游標移動時呼叫。
export function createEditor(parent, { onChange, onCursor }) {
  const extensions = [
    formatKeymap,
    basicSetup,
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
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
  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions }) });
  return {
    view,
    // 為新分頁建立獨立的編輯狀態（內容、游標、復原紀錄）
    createState(content) {
      return EditorState.create({ doc: content, extensions });
    },
  };
}
