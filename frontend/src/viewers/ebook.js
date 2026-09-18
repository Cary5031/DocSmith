// 電子書閱讀器（EPUB / MOBI / AZW3 / FB2 / CBZ）：以 foliate-js 做翻頁排版，完全離線。
import '../../vendor/foliate-js/view.js';
import { createElement, ListTree, Bookmark, BookmarkCheck, Search, ChevronLeft, ChevronRight, AArrowUp, AArrowDown } from 'lucide';
import { LoadState, SaveState } from '../../wailsjs/go/main/App';
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime';
import { t, applyToDom } from '../i18n.js';

// ---- 閱讀偏好（套用到所有書）----
const DEFAULT_PREFS = { fontSize: 100, lineHeight: 1.7, font: 'serif', theme: 'light' };
const THEMES = {
  light: { bg: '#ffffff', fg: '#1f2328', link: '#2f6fdb' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636', link: '#8a5a2b' },
  dark: { bg: '#1c1c1e', fg: '#d4d4d4', link: '#7fb0ff' },
};
const FONTS = {
  serif: '"Noto Serif TC", "PMingLiU", "MingLiU", "Songti TC", "Times New Roman", serif',
  sans: '"Microsoft JhengHei UI", "Microsoft JhengHei", "Segoe UI", sans-serif',
  original: null, // 使用書本自己的字型
};
let prefs = null;
const openBooks = new Set(); // 目前開啟的閱讀器，偏好變更時一起更新

async function loadPrefs() {
  if (prefs) return prefs;
  try {
    prefs = { ...DEFAULT_PREFS, ...JSON.parse((await LoadState('ebook.prefs')) || '{}') };
  } catch {
    prefs = { ...DEFAULT_PREFS };
  }
  return prefs;
}

function savePrefs() {
  SaveState('ebook.prefs', JSON.stringify(prefs));
  for (const ctx of openBooks) applyPrefs(ctx);
}

function bookCSS(p) {
  const theme = THEMES[p.theme] ?? THEMES.light;
  const font = FONTS[p.font];
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { color-scheme: ${p.theme === 'dark' ? 'dark' : 'light'}; font-size: ${p.fontSize}% !important; }
    html, body { background: ${theme.bg} !important; color: ${theme.fg} !important; }
    ${font ? `body, p, li, dd, blockquote, h1, h2, h3, h4, h5, h6 { font-family: ${font} !important; }` : ''}
    p, li, blockquote, dd { line-height: ${p.lineHeight} !important; }
    a:link, a:visited { color: ${theme.link} !important; }
    pre { white-space: pre-wrap !important; }
    aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="rearnote"] { display: none; }
  `;
}

function applyPrefs(ctx) {
  const theme = THEMES[prefs.theme] ?? THEMES.light;
  ctx.root.style.setProperty('--ebook-bg', theme.bg);
  ctx.root.style.setProperty('--ebook-fg', theme.fg);
  ctx.root.dataset.theme = prefs.theme;
  ctx.view.renderer?.setStyles?.(bookCSS(prefs));
  ctx.ui.fontSize.textContent = `${prefs.fontSize}%`;
  ctx.ui.lineHeight.value = String(prefs.lineHeight);
  ctx.ui.font.value = prefs.font;
  for (const b of ctx.ui.themes) b.classList.toggle('active', b.dataset.theme === prefs.theme);
}

// ---- DRM 偵測：有 DRM 的書無法解讀，直接告知使用者 ----
async function hasDRM(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) {
    // ZIP（EPUB）：rights.xml，或 encryption.xml 中有字型混淆以外的加密
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(file);
    if (zip.file('META-INF/rights.xml')) return true;
    const enc = zip.file('META-INF/encryption.xml');
    if (!enc) return false;
    const xml = await enc.async('string');
    // 只允許字型混淆（IDPF / Adobe），其餘加密演算法（例如 Adobe ADEPT 的 AES）代表有 DRM
    const fontObfuscation = /idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/;
    return [...xml.matchAll(/Algorithm="([^"]+)"/g)].some((m) => !fontObfuscation.test(m[1]));
  }
  if (/\.(mobi|azw3?)$/i.test(file.name) && file.size > 96) {
    // MOBI：第一筆記錄的加密欄位（offset 12）不為 0 代表有 DRM
    const header = new DataView(await file.slice(0, 86).arrayBuffer());
    const record0 = header.getUint32(78);
    const rec = new DataView(await file.slice(record0, record0 + 16).arrayBuffer());
    return rec.byteLength >= 14 && rec.getUint16(12) !== 0;
  }
  return false;
}

// ---- 介面 ----
function button(icon, key, onClick, className = 'tool') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.dataset.i18nTitle = key;
  b.append(createElement(icon, { width: 17, height: 17 }));
  b.addEventListener('click', onClick);
  return b;
}

function buildToolbar(ctx) {
  const bar = document.createElement('div');
  bar.className = 'viewer-toolbar';
  const sep = () => Object.assign(document.createElement('span'), { className: 'viewer-sep' });

  const toc = button(ListTree, 'ebookToc', () => toggleSide(ctx, 'toc'));
  const marks = button(Bookmark, 'ebookBookmarks', () => toggleSide(ctx, 'bookmarks'));
  const search = button(Search, 'ebookSearch', () => toggleSide(ctx, 'search'));
  const prev = button(ChevronLeft, 'prevPage', () => ctx.view.goLeft());
  const next = button(ChevronRight, 'nextPage', () => ctx.view.goRight());

  const smaller = button(AArrowDown, 'fontSmaller', () => changeFont(-10));
  const fontSize = document.createElement('span');
  fontSize.className = 'ebook-font-size';
  const larger = button(AArrowUp, 'fontLarger', () => changeFont(10));

  const lineHeight = document.createElement('select');
  lineHeight.className = 'viewer-zoom';
  lineHeight.dataset.i18nTitle = 'lineHeight';
  for (const v of ['1.4', '1.7', '2', '2.4']) lineHeight.append(new Option(`↕ ${v}`, v));
  lineHeight.addEventListener('change', () => {
    prefs.lineHeight = Number(lineHeight.value);
    savePrefs();
  });

  const font = document.createElement('select');
  font.className = 'viewer-zoom';
  font.dataset.i18nTitle = 'ebookFont';
  for (const [value, key] of [['serif', 'fontSerif'], ['sans', 'fontSans'], ['original', 'fontOriginal']]) {
    const opt = new Option('', value);
    opt.dataset.i18n = key;
    font.append(opt);
  }
  font.addEventListener('change', () => {
    prefs.font = font.value;
    savePrefs();
  });

  const themes = ['light', 'sepia', 'dark'].map((name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ebook-theme ebook-theme-${name}`;
    b.dataset.theme = name;
    b.dataset.i18nTitle = `theme_${name}`;
    b.textContent = 'A';
    b.addEventListener('click', () => {
      prefs.theme = name;
      savePrefs();
    });
    return b;
  });

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const bookmark = button(Bookmark, 'addBookmark', () => toggleBookmark(ctx));
  bookmark.classList.add('ebook-bookmark');

  bar.append(toc, marks, search, sep(), prev, next, sep(), smaller, fontSize, larger, lineHeight, font, sep(), ...themes, spacer, bookmark);
  Object.assign(ctx.ui, { fontSize, lineHeight, font, themes, bookmark });
  return bar;
}

function changeFont(delta) {
  prefs.fontSize = Math.min(250, Math.max(60, prefs.fontSize + delta));
  savePrefs();
}

// ---- 側欄：目錄 / 書籤 / 搜尋 ----
function toggleSide(ctx, mode) {
  if (!ctx.side.hidden && ctx.sideMode === mode) {
    ctx.side.hidden = true;
    return;
  }
  ctx.sideMode = mode;
  ctx.side.hidden = false;
  renderSide(ctx);
}

function renderSide(ctx) {
  const title = ctx.side.querySelector('.ebook-side-title');
  const content = ctx.side.querySelector('.ebook-side-content');
  title.textContent = t({ toc: 'ebookToc', bookmarks: 'ebookBookmarks', search: 'ebookSearch' }[ctx.sideMode]);
  content.replaceChildren();
  if (ctx.sideMode === 'toc') renderToc(ctx, content);
  if (ctx.sideMode === 'bookmarks') renderBookmarks(ctx, content);
  if (ctx.sideMode === 'search') renderSearch(ctx, content);
}

function renderToc(ctx, content) {
  const toc = ctx.view.book.toc ?? [];
  if (!toc.length) {
    content.append(Object.assign(document.createElement('p'), { className: 'ebook-empty', textContent: t('ebookNoToc') }));
    return;
  }
  const build = (items, depth) => {
    const list = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      const a = document.createElement('button');
      a.type = 'button';
      a.className = 'ebook-toc-item';
      a.style.paddingLeft = `${10 + depth * 14}px`;
      a.textContent = item.label?.trim() || '—';
      a.dataset.href = item.href ?? '';
      a.addEventListener('click', () => item.href && ctx.view.goTo(item.href));
      li.append(a);
      if (item.subitems?.length) li.append(build(item.subitems, depth + 1));
      list.append(li);
    }
    return list;
  };
  content.append(build(toc, 0));
  markToc(ctx);
}

function markToc(ctx) {
  const href = ctx.loc?.tocItem?.href;
  for (const el of ctx.side.querySelectorAll('.ebook-toc-item')) {
    const on = Boolean(href) && el.dataset.href === href;
    el.classList.toggle('current', on);
    if (on) el.scrollIntoView({ block: 'nearest' });
  }
}

function renderBookmarks(ctx, content) {
  if (!ctx.data.bookmarks.length) {
    content.append(Object.assign(document.createElement('p'), { className: 'ebook-empty', textContent: t('ebookNoBookmarks') }));
    return;
  }
  const list = document.createElement('ul');
  for (const mark of ctx.data.bookmarks) {
    const li = document.createElement('li');
    li.className = 'ebook-mark';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'ebook-toc-item';
    go.textContent = mark.label;
    go.addEventListener('click', () => ctx.view.goTo(mark.cfi));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ebook-mark-delete';
    del.textContent = '×';
    del.title = t('removeBookmark');
    del.addEventListener('click', () => {
      ctx.data.bookmarks = ctx.data.bookmarks.filter((m) => m !== mark);
      saveData(ctx);
      renderSide(ctx);
      updateBookmarkButton(ctx);
    });
    li.append(go, del);
    list.append(li);
  }
  content.append(list);
}

function renderSearch(ctx, content) {
  const box = document.createElement('label');
  box.className = 'viewer-find ebook-find';
  box.append(createElement(Search, { width: 15, height: 15 }));
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = t('findPlaceholder');
  input.value = ctx.lastQuery ?? '';
  box.append(input);
  const status = document.createElement('p');
  status.className = 'ebook-empty';
  const results = document.createElement('ul');
  content.append(box, status, results);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch(ctx, input.value.trim(), status, results);
    if (e.key === 'Escape') ctx.side.hidden = true;
  });
  ctx.focusSearch = () => {
    input.focus();
    input.select();
  };
  setTimeout(ctx.focusSearch, 0);
}

async function runSearch(ctx, query, status, results) {
  const run = (ctx.searchRun = (ctx.searchRun ?? 0) + 1);
  ctx.lastQuery = query;
  results.replaceChildren();
  ctx.view.clearSearch();
  if (!query) {
    status.textContent = '';
    return;
  }
  status.textContent = t('searching');
  let count = 0;
  for await (const result of ctx.view.search({ query })) {
    if (run !== ctx.searchRun) return; // 已有新的搜尋
    if (result === 'done') break;
    if (result.progress != null) {
      status.textContent = `${t('searching')} ${Math.round(result.progress * 100)}%`;
      continue;
    }
    for (const item of result.subitems ?? []) {
      if (count >= 500) break;
      count++;
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ebook-result';
      const label = document.createElement('span');
      label.className = 'ebook-result-label';
      label.textContent = result.label ?? '';
      const excerpt = document.createElement('span');
      const mark = document.createElement('mark');
      mark.textContent = item.excerpt?.match ?? query;
      excerpt.append(item.excerpt?.pre ?? '', mark, item.excerpt?.post ?? '');
      b.append(label, excerpt);
      b.addEventListener('click', () => ctx.view.goTo(item.cfi));
      li.append(b);
      results.append(li);
    }
  }
  if (run === ctx.searchRun) status.textContent = count ? t('searchResults', { count }) : t('findNoResult');
}

// ---- 書籤與閱讀位置 ----
// 同一個檔案不論以 \ 或 / 表示、大小寫是否相同，都對應到同一筆資料
function dataKey(path) {
  return 'ebook:' + path.replace(/\\/g, '/').toLowerCase();
}

function saveData(ctx) {
  SaveState(dataKey(ctx.path), JSON.stringify(ctx.data));
}

let saveTimer = null;
function savePositionSoon(ctx) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveData(ctx), 800);
}

function percentOf(ctx) {
  return Math.round((ctx.loc?.fraction ?? 0) * 100);
}

function updateBookmarkButton(ctx) {
  const cfi = ctx.loc?.cfi;
  const marked = Boolean(cfi) && ctx.data.bookmarks.some((m) => m.cfi === cfi);
  ctx.ui.bookmark.replaceChildren(createElement(marked ? BookmarkCheck : Bookmark, { width: 17, height: 17 }));
  ctx.ui.bookmark.classList.toggle('active', marked);
  ctx.ui.bookmark.dataset.i18nTitle = marked ? 'removeBookmark' : 'addBookmark';
  ctx.ui.bookmark.title = t(ctx.ui.bookmark.dataset.i18nTitle);
}

function toggleBookmark(ctx) {
  const cfi = ctx.loc?.cfi;
  if (!cfi) return;
  const existing = ctx.data.bookmarks.find((m) => m.cfi === cfi);
  if (existing) {
    ctx.data.bookmarks = ctx.data.bookmarks.filter((m) => m !== existing);
  } else {
    const chapter = ctx.loc?.tocItem?.label?.trim() || t('ebookPosition');
    ctx.data.bookmarks.push({ cfi, fraction: ctx.loc.fraction, label: `${chapter} · ${percentOf(ctx)}%` });
    ctx.data.bookmarks.sort((a, b) => a.fraction - b.fraction);
  }
  saveData(ctx);
  updateBookmarkButton(ctx);
  if (!ctx.side.hidden && ctx.sideMode === 'bookmarks') renderSide(ctx);
}

// ---- 鍵盤與滾輪翻頁 ----
function isTyping(e) {
  const tag = e.target?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

function handleKey(ctx, e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl) {
    if (e.key === 'f' || e.key === 'F') {
      if (ctx.side.hidden || ctx.sideMode !== 'search') toggleSide(ctx, 'search');
      else ctx.focusSearch?.();
      return true;
    }
    if (e.key === '+' || e.key === '=') return changeFont(10), true;
    if (e.key === '-') return changeFont(-10), true;
    return false;
  }
  if (isTyping(e)) return false;
  switch (e.key) {
    case 'ArrowLeft':
      ctx.view.goLeft();
      return true;
    case 'ArrowRight':
      ctx.view.goRight();
      return true;
    case 'ArrowUp':
    case 'PageUp':
      ctx.view.prev();
      return true;
    case 'ArrowDown':
    case 'PageDown':
      ctx.view.next();
      return true;
    case ' ':
      if (e.shiftKey) ctx.view.prev();
      else ctx.view.next();
      return true;
    default:
      return false;
  }
}

function attachInput(ctx, target) {
  let wheelLock = 0;
  target.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) < 4 || Date.now() < wheelLock) return;
      wheelLock = Date.now() + 350;
      if (e.deltaY > 0) ctx.view.next();
      else ctx.view.prev();
    },
    { passive: true },
  );
}

export const ebookViewer = {
  async open(tab, el, path, app) {
    await loadPrefs();
    const res = await fetch('/__doc?p=' + encodeURIComponent(path));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const file = new File([await res.blob()], app.fileName(path));
    if (await hasDRM(file)) throw new Error(t('drmProtected'));

    const ctx = { ui: {}, app, path, root: el, data: { cfi: null, fraction: 0, bookmarks: [] } };
    try {
      ctx.data = { ...ctx.data, ...JSON.parse((await LoadState(dataKey(path))) || '{}') };
    } catch {
      /* 沒有儲存過的資料 */
    }
    tab.ebook = ctx;
    el.classList.add('ebook');

    const body = document.createElement('div');
    body.className = 'viewer-body';
    ctx.side = document.createElement('aside');
    ctx.side.className = 'ebook-side';
    ctx.side.hidden = true;
    ctx.side.innerHTML = '<div class="ebook-side-title"></div><div class="ebook-side-content"></div>';
    const stage = document.createElement('div');
    stage.className = 'ebook-stage';
    ctx.view = document.createElement('foliate-view');
    stage.append(ctx.view);
    body.append(ctx.side, stage);

    const footer = document.createElement('div');
    footer.className = 'ebook-footer';
    const chapter = document.createElement('span');
    chapter.className = 'ebook-chapter';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 1;
    slider.step = 'any';
    slider.addEventListener('change', () => ctx.view.goToFraction(Number(slider.value)));
    const percent = document.createElement('span');
    percent.className = 'ebook-percent';
    footer.append(chapter, slider, percent);
    Object.assign(ctx.ui, { chapter, slider, percent });

    el.append(buildToolbar(ctx), body, footer);
    applyToDom(el);

    await ctx.view.open(file);
    const renderer = ctx.view.renderer;
    if (!ctx.view.isFixedLayout) {
      renderer.setAttribute('flow', 'paginated');
      renderer.setAttribute('gap', '6%');
      renderer.setAttribute('margin', '36px');
      renderer.setAttribute('max-inline-size', '720px');
      renderer.setAttribute('max-column-count', '2');
    }
    openBooks.add(ctx);
    applyPrefs(ctx);

    ctx.view.addEventListener('relocate', (e) => {
      ctx.loc = e.detail;
      ctx.data.cfi = e.detail.cfi;
      ctx.data.fraction = e.detail.fraction;
      slider.value = e.detail.fraction ?? 0;
      chapter.textContent = e.detail.tocItem?.label?.trim() ?? '';
      percent.textContent = `${percentOf(ctx)}%`;
      updateBookmarkButton(ctx);
      if (!ctx.side.hidden && ctx.sideMode === 'toc') markToc(ctx);
      savePositionSoon(ctx);
      if (app.active === tab) app.updateStatusInfo();
    });
    // 書中的外部連結用預設瀏覽器開啟
    ctx.view.addEventListener('external-link', (e) => {
      e.preventDefault();
      BrowserOpenURL(e.detail.href_ ?? e.detail.href ?? e.detail.a?.href);
    });
    // 每一章載入時，把鍵盤與滾輪事件接起來（內容在 iframe 裡）
    ctx.view.addEventListener('load', (e) => {
      const doc = e.detail.doc;
      doc.addEventListener('keydown', (ev) => {
        if (handleKey(ctx, ev)) {
          ev.preventDefault();
        } else if (ev.ctrlKey || ev.metaKey) {
          // 其餘 Ctrl 快捷鍵（Ctrl+W、Ctrl+Tab…）交給主程式
          document.dispatchEvent(new KeyboardEvent('keydown', { key: ev.key, ctrlKey: true, shiftKey: ev.shiftKey, bubbles: true }));
          ev.preventDefault();
        }
      });
      attachInput(ctx, doc);
    });
    attachInput(ctx, stage);

    await ctx.view.init({ lastLocation: ctx.data.cfi, showTextStart: !ctx.data.cfi });
  },

  status(tab) {
    const ctx = tab.ebook;
    if (!ctx?.loc) return '';
    return t('ebookStatus', { chapter: ctx.loc.tocItem?.label?.trim() ?? '', percent: percentOf(ctx) });
  },

  onKey(tab, e) {
    return tab.ebook ? handleKey(tab.ebook, e) : false;
  },

  onActivate(tab) {
    tab.ebook?.view.focus();
  },

  destroy(tab) {
    const ctx = tab.ebook;
    if (!ctx) return;
    tab.ebook = null;
    openBooks.delete(ctx);
    clearTimeout(saveTimer);
    saveData(ctx);
    try {
      ctx.view.close();
    } catch {
      /* 關閉失敗不影響 */
    }
  },
};
