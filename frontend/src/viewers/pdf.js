// PDF 閱讀器：以 pdf.js 的 PDFViewer 元件顯示原始頁面（離線、分段讀取、不執行 PDF 內的腳本）。
import 'pdfjs-dist/web/pdf_viewer.css';
import { createElement, PanelLeft, ChevronUp, ChevronDown, ZoomIn, ZoomOut, Search } from 'lucide';
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime';
import { t, applyToDom } from '../i18n.js';

let pdfjs = null;
let viewerLib = null;

async function loadLibraries() {
  if (viewerLib) return;
  pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  globalThis.pdfjsLib = pdfjs; // pdf_viewer.mjs 需要全域的 pdfjsLib
  viewerLib = await import('pdfjs-dist/web/pdf_viewer.mjs');
}

const ZOOMS = [
  ['auto', 'zoomAuto'],
  ['page-width', 'zoomPageWidth'],
  ['page-fit', 'zoomPageFit'],
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100%'],
  ['1.25', '125%'],
  ['1.5', '150%'],
  ['2', '200%'],
  ['3', '300%'],
];

function button(icon, key, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tool';
  b.dataset.i18nTitle = key;
  b.append(createElement(icon, { width: 17, height: 17 }));
  b.addEventListener('click', onClick);
  return b;
}

function buildToolbar(ctx) {
  const bar = document.createElement('div');
  bar.className = 'viewer-toolbar';

  const thumbs = button(PanelLeft, 'pdfThumbnails', () => toggleThumbnails(ctx));
  const prev = button(ChevronUp, 'prevPage', () => ctx.viewer.previousPage());
  const next = button(ChevronDown, 'nextPage', () => ctx.viewer.nextPage());
  const page = document.createElement('input');
  page.className = 'viewer-page';
  page.type = 'number';
  page.min = 1;
  page.addEventListener('change', () => {
    const n = Number(page.value);
    if (n >= 1 && n <= ctx.doc.numPages) ctx.viewer.currentPageNumber = n;
    else page.value = ctx.viewer.currentPageNumber;
  });
  const total = document.createElement('span');
  total.className = 'viewer-total';

  const zoomOut = button(ZoomOut, 'zoomOut', () => ctx.viewer.decreaseScale());
  const zoomIn = button(ZoomIn, 'zoomIn', () => ctx.viewer.increaseScale());
  const zoom = document.createElement('select');
  zoom.className = 'viewer-zoom';
  for (const [value, label] of ZOOMS) {
    const opt = new Option(label.endsWith('%') ? label : '', value);
    if (!label.endsWith('%')) opt.dataset.i18n = label;
    zoom.append(opt);
  }
  zoom.append(new Option('', 'custom'));
  zoom.addEventListener('change', () => {
    if (zoom.value !== 'custom') ctx.viewer.currentScaleValue = zoom.value;
  });

  const findBox = document.createElement('label');
  findBox.className = 'viewer-find';
  findBox.append(createElement(Search, { width: 15, height: 15 }));
  const find = document.createElement('input');
  find.type = 'search';
  find.dataset.i18nPlaceholder = 'findPlaceholder';
  const count = document.createElement('span');
  count.className = 'viewer-find-count';
  const findPrev = button(ChevronUp, 'findPrev', () => runFind(ctx, 'again', true));
  const findNext = button(ChevronDown, 'findNext', () => runFind(ctx, 'again', false));
  find.addEventListener('input', () => runFind(ctx, '', false));
  find.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFind(ctx, 'again', e.shiftKey);
    }
  });
  findBox.append(find, count);

  const sep = () => Object.assign(document.createElement('span'), { className: 'viewer-sep' });
  bar.append(thumbs, sep(), prev, next, page, total, sep(), zoomOut, zoom, zoomIn, sep(), findBox, findPrev, findNext);
  Object.assign(ctx.ui, { page, total, zoom, find, count });
  return bar;
}

function runFind(ctx, type, findPrevious) {
  const query = ctx.ui.find.value;
  if (!query) {
    ctx.ui.count.textContent = '';
  }
  ctx.eventBus.dispatch('find', {
    source: ctx,
    type,
    query,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  });
}

// ---- 縮圖側欄：進入畫面時才繪製 ----
function toggleThumbnails(ctx) {
  ctx.thumbs.hidden = !ctx.thumbs.hidden;
  if (!ctx.thumbs.hidden && !ctx.thumbs.childElementCount) buildThumbnails(ctx);
}

function buildThumbnails(ctx) {
  ctx.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.target.dataset.rendered) continue;
        entry.target.dataset.rendered = '1';
        renderThumbnail(ctx, entry.target);
      }
    },
    { root: ctx.thumbs, rootMargin: '200px' },
  );
  for (let n = 1; n <= ctx.doc.numPages; n++) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pdf-thumb';
    item.dataset.page = n;
    const canvas = document.createElement('canvas');
    const label = document.createElement('span');
    label.textContent = n;
    item.append(canvas, label);
    item.addEventListener('click', () => (ctx.viewer.currentPageNumber = n));
    ctx.thumbs.append(item);
    ctx.observer.observe(item);
  }
  markThumbnail(ctx);
}

async function renderThumbnail(ctx, item) {
  const page = await ctx.doc.getPage(Number(item.dataset.page));
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 110 / base.width });
  const canvas = item.querySelector('canvas');
  const ratio = window.devicePixelRatio || 1;
  canvas.width = viewport.width * ratio;
  canvas.height = viewport.height * ratio;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0] }).promise;
}

function markThumbnail(ctx) {
  const current = ctx.viewer.currentPageNumber;
  for (const item of ctx.thumbs.children) {
    const on = Number(item.dataset.page) === current;
    item.classList.toggle('current', on);
    if (on && !ctx.thumbs.hidden) item.scrollIntoView({ block: 'nearest' });
  }
}

export const pdfViewer = {
  async open(tab, el, path, app) {
    await loadLibraries();
    const { EventBus, PDFLinkService, PDFFindController, PDFViewer } = viewerLib;
    const ctx = { ui: {}, app };
    tab.pdf = ctx;

    const body = document.createElement('div');
    body.className = 'viewer-body';
    ctx.thumbs = document.createElement('div');
    ctx.thumbs.className = 'pdf-thumbs';
    ctx.thumbs.hidden = true;
    const container = document.createElement('div');
    container.className = 'pdf-container';
    const inner = document.createElement('div');
    inner.className = 'pdfViewer';
    container.append(inner);
    body.append(ctx.thumbs, container);
    el.append(buildToolbar(ctx), body);
    applyToDom(el);

    // 外部連結用預設瀏覽器開啟，不在程式內跳頁
    container.addEventListener(
      'click',
      (e) => {
        const a = e.target.closest('a[href]');
        const href = a?.getAttribute('href') ?? '';
        if (/^(https?|mailto):/i.test(href)) {
          e.preventDefault();
          e.stopPropagation();
          BrowserOpenURL(href);
        }
      },
      true,
    );

    ctx.eventBus = new EventBus();
    ctx.linkService = new PDFLinkService({ eventBus: ctx.eventBus });
    ctx.findController = new PDFFindController({ eventBus: ctx.eventBus, linkService: ctx.linkService });
    ctx.viewer = new PDFViewer({
      container,
      viewer: inner,
      eventBus: ctx.eventBus,
      linkService: ctx.linkService,
      findController: ctx.findController,
      textLayerMode: 1,
    });
    ctx.linkService.setViewer(ctx.viewer);

    // 透過本機檔案服務以 HTTP Range 分段讀取；不執行 PDF 內的 JavaScript
    ctx.doc = await pdfjs.getDocument({
      url: '/__doc?p=' + encodeURIComponent(path),
      isEvalSupported: false,
      enableXfa: false,
      disableAutoFetch: true,
    }).promise;
    ctx.viewer.setDocument(ctx.doc);
    ctx.linkService.setDocument(ctx.doc);
    ctx.ui.total.textContent = `/ ${ctx.doc.numPages}`;
    ctx.ui.page.max = ctx.doc.numPages;

    const bus = ctx.eventBus;
    bus.on('pagesinit', () => {
      ctx.viewer.currentScaleValue = 'page-width';
    });
    bus.on('pagechanging', ({ pageNumber }) => {
      ctx.ui.page.value = pageNumber;
      if (!ctx.thumbs.hidden) markThumbnail(ctx);
      app.updateStatusInfo();
    });
    bus.on('scalechanging', ({ presetValue, scale }) => {
      const preset = presetValue && ZOOMS.some(([v]) => v === presetValue);
      const exact = ZOOMS.find(([v]) => Number(v) === scale);
      const custom = ctx.ui.zoom.querySelector('option[value="custom"]');
      custom.textContent = `${Math.round(scale * 100)}%`;
      ctx.ui.zoom.value = preset ? presetValue : exact ? exact[0] : 'custom';
      app.updateStatusInfo();
    });
    const showCount = ({ matchesCount }) => {
      if (!ctx.ui.find.value) {
        ctx.ui.count.textContent = '';
      } else {
        ctx.ui.count.textContent = matchesCount?.total ? `${matchesCount.current} / ${matchesCount.total}` : t('findNoResult');
      }
    };
    bus.on('updatefindmatchescount', showCount);
    bus.on('updatefindcontrolstate', showCount);
    ctx.ui.page.value = 1;
  },

  // 側欄大綱：PDF 內建的書籤目錄
  async outline(tab) {
    const ctx = tab.pdf;
    if (!ctx?.doc) return [];
    const out = [];
    const walk = (items, level) => {
      for (const item of items ?? []) {
        if (item.dest) out.push({ label: item.title, level, go: () => ctx.linkService.goToDestination(item.dest) });
        walk(item.items, level + 1);
      }
    };
    walk(await ctx.doc.getOutline(), 0);
    return out;
  },

  status(tab) {
    const ctx = tab.pdf;
    if (!ctx?.doc) return '';
    return t('pdfStatus', {
      page: ctx.viewer.currentPageNumber,
      total: ctx.doc.numPages,
      zoom: Math.round((ctx.viewer.currentScale || 1) * 100),
    });
  },

  // 分頁快捷鍵；回傳 true 表示已處理
  onKey(tab, e) {
    const ctx = tab.pdf;
    if (!ctx?.viewer || !(e.ctrlKey || e.metaKey)) return false;
    switch (e.key) {
      case 'f':
      case 'F':
        if (e.shiftKey) return false; // Ctrl+Shift+F 是全文搜尋
        ctx.ui.find.focus();
        ctx.ui.find.select();
        return true;
      case '+':
      case '=':
        ctx.viewer.increaseScale();
        return true;
      case '-':
        ctx.viewer.decreaseScale();
        return true;
      case '0':
        ctx.viewer.currentScaleValue = 'page-width';
        return true;
      default:
        return false;
    }
  },

  destroy(tab) {
    const ctx = tab.pdf;
    if (!ctx) return;
    tab.pdf = null;
    ctx.observer?.disconnect();
    try {
      ctx.viewer?.cleanup();
    } catch {
      /* 清理失敗不影響關閉分頁 */
    }
    ctx.doc?.destroy().catch(() => {});
  },
};
