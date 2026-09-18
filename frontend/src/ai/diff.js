// 套用 AI 改寫前的差異比較對話框（逐行顯示新增 / 刪除）。
import { diffLines } from 'diff';
import { t } from '../i18n.js';

let root = null;
let ui = {};

function build() {
  root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.id = 'mdb-diff-modal';
  root.hidden = true;
  const box = document.createElement('div');
  box.className = 'modal modal-diff';
  const title = document.createElement('h2');
  const summary = document.createElement('p');
  summary.className = 'diff-summary';
  const body = document.createElement('div');
  body.className = 'diff-body';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'primary';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  actions.append(apply, cancel);
  box.append(title, summary, body, actions);
  root.append(box);
  document.body.append(root);
  ui = { title, summary, body, apply, cancel };
}

// 顯示差異；回傳 true 表示使用者選擇套用
export function showDiff({ title, before, after }) {
  if (!root) build();
  const parts = diffLines(before, after);
  let added = 0;
  let removed = 0;
  const lines = [];
  for (const part of parts) {
    const partLines = part.value.split('\n');
    if (partLines.at(-1) === '') partLines.pop();
    for (const line of partLines) {
      if (part.added) added++;
      if (part.removed) removed++;
      lines.push({ type: part.added ? 'add' : part.removed ? 'del' : 'same', line });
    }
  }
  // 未變動的區塊只顯示前後 2 行
  const visible = lines.filter((item, i) => {
    if (item.type !== 'same') return true;
    const near = lines.slice(Math.max(0, i - 2), i + 3);
    return near.some((x) => x.type !== 'same');
  });
  ui.title.textContent = title ?? t('diffTitle');
  ui.summary.textContent = t('diffSummary', { added, removed });
  ui.body.replaceChildren(
    ...visible.map((item) => {
      const row = document.createElement('div');
      row.className = `diff-line diff-${item.type}`;
      row.textContent = (item.type === 'add' ? '+ ' : item.type === 'del' ? '- ' : '  ') + item.line;
      return row;
    }),
  );
  ui.apply.textContent = t('diffApply');
  ui.cancel.textContent = t('btnCancel');
  root.hidden = false;
  return new Promise((resolve) => {
    const finish = (value) => {
      root.hidden = true;
      ui.apply.onclick = null;
      ui.cancel.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    };
    ui.apply.onclick = () => finish(true);
    ui.cancel.onclick = () => finish(false);
    document.addEventListener('keydown', onKey, true);
    ui.apply.focus();
  });
}
