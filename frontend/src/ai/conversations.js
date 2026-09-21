// AI 對話的資料層：一組對話一個檔，存在專案的 .DocSmith\chats（加密）與 %APPDATA% 明文備援。
// 這裡只管資料；清單的畫面在 history.js，訊息的畫面在 panel.js。
import { SaveChat, LoadChat, DeleteChat, ListChats, SetChatFolder, LoadState, SaveState } from '../../wailsjs/go/main/App';

const MAX_MESSAGES = 60; // 每組對話保留的訊息則數
const SAVE_DELAY = 800;

let current = null; // { id, title, updated, messages }
let saveTimer = null;

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function emptyChat() {
  return { id: newId(), title: '', updated: Date.now(), messages: [] };
}

// 標題取第一則使用者訊息的前 20 字
function titleOf(chat) {
  if (chat.title) return chat.title;
  const first = chat.messages.find((m) => m.role === 'user');
  if (!first) return '';
  const line = first.content.split('\n').find((l) => l.trim()) ?? '';
  return line.trim().slice(0, 20);
}

export function currentChat() {
  return (current ??= emptyChat());
}

export function messages() {
  return currentChat().messages;
}

export function setMessages(list) {
  currentChat().messages = list;
}

// 存檔（預設延遲合併多次呼叫；關閉程式前用 immediate）
export function saveCurrent(immediate = false) {
  const chat = currentChat();
  chat.updated = Date.now();
  chat.title = titleOf(chat);
  if (!chat.messages.length) return Promise.resolve(); // 空的對話不留下檔案
  const write = () => SaveChat(chat.id, JSON.stringify({ ...chat, messages: chat.messages.slice(-MAX_MESSAGES) }));
  clearTimeout(saveTimer);
  if (immediate) return write();
  saveTimer = setTimeout(write, SAVE_DELAY);
  return Promise.resolve();
}

export async function startNew() {
  await saveCurrent(true);
  current = emptyChat();
  await SaveState('ai.current', JSON.stringify(current.id));
  return current;
}

export async function switchTo(id) {
  if (id === currentChat().id) return current;
  await saveCurrent(true);
  try {
    const raw = await LoadChat(id);
    const chat = JSON.parse(raw);
    current = { id: chat.id ?? id, title: chat.title ?? '', updated: chat.updated ?? Date.now(), messages: chat.messages ?? [] };
    current.messages.forEach((m) => (m.done = true));
  } catch {
    current = emptyChat();
  }
  await SaveState('ai.current', JSON.stringify(current.id));
  return current;
}

export async function removeChat(id) {
  await DeleteChat(id);
  if (id === currentChat().id) {
    current = emptyChat();
    await SaveState('ai.current', JSON.stringify(current.id));
  }
}

export function listChats() {
  return ListChats();
}

// 切換資料夾：先存好目前這組，再換到該資料夾最新的一組（沒有就開新的）
export async function useFolder(folder) {
  await saveCurrent(true);
  await SetChatFolder(folder || '');
  const list = await ListChats();
  if (list.length) await switchTo(list[0].id);
  else {
    current = emptyChat();
    await SaveState('ai.current', JSON.stringify(current.id));
  }
  return current;
}

// 舊版把唯一一組對話存在 state.json 的 ai.chat，搬成第一組對話檔
async function migrateLegacy() {
  let legacy = null;
  try {
    legacy = JSON.parse((await LoadState('ai.chat')) || '{}');
  } catch {
    return false;
  }
  if (!legacy?.messages?.length) return false;
  current = { id: newId(), title: '', updated: Date.now(), messages: legacy.messages };
  current.messages.forEach((m) => (m.done = true));
  await saveCurrent(true);
  await SaveState('ai.chat', ''); // 搬完就清掉，不會重複搬
  await SaveState('ai.current', JSON.stringify(current.id));
  return true;
}

export async function initConversations(folder) {
  await SetChatFolder(folder || '');
  if (await migrateLegacy()) return current;
  let wanted = '';
  try {
    wanted = JSON.parse((await LoadState('ai.current')) || '""');
  } catch {
    wanted = '';
  }
  const list = await ListChats();
  const pick = list.find((c) => c.id === wanted) ?? list[0];
  if (pick) return switchTo(pick.id);
  current = emptyChat();
  return current;
}
