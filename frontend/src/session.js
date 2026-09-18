// 工作階段還原（重開時開回上次的分頁）與未存檔內容的自動備份 / 當機復原。
import { LoadState, SaveState, PathExists, WriteBackup, DeleteBackup, ListBackups, ClearBackups } from '../wailsjs/go/main/App';
import { t } from './i18n.js';
import { isEditorKind } from './kinds.js';

const BACKUP_DELAY = 3000;
let app = null;
const backupTimers = new Map();
let sessionTimer = null;

const norm = (p) => (p ?? '').replace(/\\/g, '/').toLowerCase();
const backupId = (tab) => `tab${tab.id}`;

// ---- 工作階段 ----
function snapshot() {
  return {
    tabs: app.tabs.filter((tab) => tab.path).map((tab) => ({ path: tab.path, kind: tab.kind })),
    active: app.active?.path || null,
  };
}

function saveSessionSoon() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => SaveState('session', JSON.stringify(snapshot())), 500);
}

// 啟動時開回上次的分頁（略過已不存在的檔案），並切回上次作用中的分頁
export async function restoreSession() {
  let saved = {};
  try {
    saved = JSON.parse((await LoadState('session')) || '{}');
  } catch {
    return;
  }
  for (const item of saved.tabs ?? []) {
    if (item.path && (await PathExists(item.path))) {
      try {
        await app.openPath(item.path);
      } catch {
        /* 開不起來的檔案略過 */
      }
    }
  }
  const target = saved.active && app.tabs.find((tab) => norm(tab.path) === norm(saved.active));
  if (target) await app.activate(target);
}

// ---- 自動備份 ----
function scheduleBackup(tab) {
  if (!tab || !isEditorKind(tab.kind)) return;
  clearTimeout(backupTimers.get(tab.id));
  backupTimers.set(tab.id, setTimeout(() => backupNow(tab), BACKUP_DELAY));
}

function backupNow(tab) {
  backupTimers.delete(tab.id);
  if (!app.tabs.includes(tab)) return;
  if (!tab.dirty) {
    DeleteBackup(backupId(tab));
    return;
  }
  WriteBackup(
    backupId(tab),
    JSON.stringify({ path: tab.path, kind: tab.kind, encoding: tab.encoding, crlf: tab.crlf, bom: tab.bom, content: app.textOf(tab), time: Date.now() }),
  );
}

function dropBackup(tab) {
  clearTimeout(backupTimers.get(tab.id));
  backupTimers.delete(tab.id);
  DeleteBackup(backupId(tab));
}

// 啟動時發現上次沒有正常關閉留下的備份：詢問還原或捨棄
export async function recoverBackups() {
  const backups = (await ListBackups())
    .map((text) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })
    .filter((b) => b && typeof b.content === 'string');
  if (!backups.length) return;
  const names = backups.map((b) => app.fileName(b.path)).join('、');
  const answer = await app.showModal(t('recoverTitle'), t('recoverMessage', { count: backups.length, names }), [
    { label: t('btnRestore'), value: 'restore', primary: true },
    { label: t('btnDiscardBackup'), value: 'discard' },
  ], 'later');
  if (answer === 'later') return; // 按 Esc：保留備份，下次再問
  await ClearBackups();
  if (answer !== 'restore') return;
  for (const b of backups) {
    const tab = await app.openRestored(b, b.content);
    scheduleBackup(tab);
  }
}

export function initSession(appApi) {
  app = appApi;
  app.on('active', saveSessionSoon);
  app.on('tabs', saveSessionSoon);
  app.on('change', scheduleBackup);
  app.on('saved', () => app.active && dropBackup(app.active));
  app.on('closed', dropBackup);
  // 正常結束：記下工作階段、清除備份（未存檔的內容使用者已確認過要不要存）
  app.onQuit(async () => {
    clearTimeout(sessionTimer);
    for (const timer of backupTimers.values()) clearTimeout(timer);
    await SaveState('session', JSON.stringify(snapshot()));
    await ClearBackups();
  });
}
