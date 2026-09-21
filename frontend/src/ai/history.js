// 對話紀錄：清單（切換 / 刪除）、匯出單一對話為 Markdown、備份與還原整份紀錄。
// 匯出與備份都是使用者主動操作，一律存成明文。
import { createElement, Download, Trash2, Save, Upload } from 'lucide';
import { ListChats, LoadChat, SaveChat, ChatFolder, ExportDialog, SaveFile, ReadFile, PickChatBackup } from '../../wailsjs/go/main/App';
import { t } from '../i18n.js';

const $ = (id) => document.getElementById(id);

let app = null;
let handlers = {};
let open = false;
let currentId = null;

export function initHistory(appApi, actions) {
  app = appApi;
  handlers = actions;
}

export function closeHistory() {
  open = false;
  const el = $('mdb-ai-history');
  if (el) el.hidden = true;
}

export function toggleHistory(activeId) {
  open = !open;
  refreshHistory(activeId);
}

export async function refreshHistory(activeId) {
  const el = $('mdb-ai-history');
  if (!el) return;
  if (activeId !== undefined) currentId = activeId;
  el.hidden = !open;
  if (!open) return;
  const chats = await ListChats().catch(() => []);
  el.replaceChildren(buildActions(), buildList(chats), buildFooter());
}

function miniButton(icon, key, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ai-mini';
  b.title = t(key);
  b.append(createElement(icon, { width: 14, height: 14 }));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function buildActions() {
  const bar = document.createElement('div');
  bar.className = 'ai-history-actions';
  const backup = document.createElement('button');
  backup.type = 'button';
  backup.className = 'ai-action';
  backup.append(createElement(Save, { width: 14, height: 14 }), document.createTextNode(` ${t('aiBackupAll')}`));
  backup.addEventListener('click', backupAll);
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'ai-action';
  restore.append(createElement(Upload, { width: 14, height: 14 }), document.createTextNode(` ${t('aiRestoreBackup')}`));
  restore.addEventListener('click', restoreBackup);
  bar.append(backup, restore);
  return bar;
}

function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildList(chats) {
  const list = document.createElement('div');
  list.className = 'ai-history-list';
  if (!chats.length) {
    const empty = document.createElement('p');
    empty.className = 'ai-history-empty';
    empty.textContent = t('aiHistoryEmpty');
    list.append(empty);
    return list;
  }
  for (const chat of chats) {
    const row = document.createElement('div');
    row.className = 'ai-history-item' + (chat.id === currentId ? ' on' : '');
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'ai-history-open';
    const title = document.createElement('span');
    title.className = 'ai-history-title';
    title.textContent = chat.title || t('aiHistoryUntitled');
    const meta = document.createElement('span');
    meta.className = 'ai-history-meta';
    meta.textContent = `${formatTime(chat.updated)}　${t('aiHistoryCount', { count: chat.count })}${chat.backup ? `　${t('aiHistoryFromBackup')}` : ''}`;
    openButton.append(title, meta);
    openButton.addEventListener('click', async () => {
      currentId = chat.id;
      await handlers.open?.(chat.id);
    });
    row.append(openButton, miniButton(Download, 'aiExportChat', () => exportOne(chat)), miniButton(Trash2, 'aiDeleteChat', () => removeOne(chat)));
    list.append(row);
  }
  return list;
}

function buildFooter() {
  const p = document.createElement('p');
  p.className = 'ai-history-path';
  ChatFolder()
    .then((dir) => (p.textContent = t('aiHistoryPath', { path: dir })))
    .catch(() => {});
  return p;
}

// ---- 匯出 / 備份 / 還原 ----

function chatToMarkdown(chat) {
  const lines = [`# ${chat.title || t('aiHistoryUntitled')}`, '', `> ${formatTime(chat.updated)}　${t('aiHistoryCount', { count: chat.messages.length })}`, ''];
  for (const message of chat.messages) {
    lines.push(`## ${message.role === 'user' ? t('aiExportUser') : t('aiExportAssistant')}`, '');
    if (message.think?.trim()) {
      lines.push(`<details><summary>${t('aiThinkTitle')}</summary>`, '', message.think.trim(), '', '</details>', '');
    }
    lines.push(message.content, '');
  }
  return lines.join('\n');
}

async function exportOne(meta) {
  try {
    const chat = JSON.parse(await LoadChat(meta.id));
    const name = (chat.title || t('aiHistoryUntitled')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const path = await ExportDialog(t('aiExportChat'), `${name}.md`, t('markdownFiles'), 'md');
    if (!path) return;
    await SaveFile(path, chatToMarkdown(chat), true, false, 'utf-8');
    app.flashMessage(t('aiExported', { name: path.split(/[\\/]/).pop() }));
  } catch (err) {
    app.showError(String(err));
  }
}

async function removeOne(meta) {
  const answer = await app.showModal(t('aiDeleteChat'), t('aiDeleteChatMessage', { name: meta.title || t('aiHistoryUntitled') }), [
    { label: t('btnDiscard'), value: 'ok', primary: true },
    { label: t('btnCancel'), value: 'cancel' },
  ]);
  if (answer !== 'ok') return;
  await handlers.remove?.(meta.id);
}

async function backupAll() {
  try {
    const metas = await ListChats();
    const chats = [];
    for (const meta of metas) {
      try {
        chats.push(JSON.parse(await LoadChat(meta.id)));
      } catch {
        /* 個別讀不到就跳過，不中斷整份備份 */
      }
    }
    if (!chats.length) {
      app.flashMessage(t('aiHistoryEmpty'));
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await ExportDialog(t('aiBackupAll'), `DocSmith-chats-${stamp}.json`, t('aiBackupFiles'), 'json');
    if (!path) return;
    await SaveFile(path, JSON.stringify({ app: 'DocSmith', version: 1, exported: Date.now(), chats }, null, 2), true, false, 'utf-8');
    app.flashMessage(t('aiBackupDone', { count: chats.length }));
  } catch (err) {
    app.showError(String(err));
  }
}

async function restoreBackup() {
  try {
    const path = await PickChatBackup(t('aiRestoreBackup'), t('aiBackupFiles'));
    if (!path) return;
    const doc = await ReadFile(path);
    const data = JSON.parse(doc.content);
    const chats = Array.isArray(data) ? data : (data.chats ?? []);
    let restored = 0;
    for (const chat of chats) {
      if (!chat?.messages?.length) continue;
      const id = /^[A-Za-z0-9_-]{1,64}$/.test(chat.id ?? '') ? chat.id : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await SaveChat(id, JSON.stringify({ ...chat, id }));
      restored++;
    }
    await refreshHistory();
    app.flashMessage(t('aiRestoreDone', { count: restored }));
  } catch (err) {
    app.showError(String(err));
  }
}
