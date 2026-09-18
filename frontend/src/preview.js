import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import markdownItKatex from '@vscode/markdown-it-katex';
import 'katex/dist/katex.min.css';
import { t } from './i18n.js';

const md = new MarkdownIt({
  html: true,
  linkify: true,
  // 回傳的內容不以 <pre 開頭，markdown-it 會自己包 <pre><code>，data-line 才會保留
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* 交給預設處理 */
      }
    }
    return '';
  },
})
  .use(taskLists, { label: true })
  // 數學公式：$行內$、$$區塊$$、```math
  .use(markdownItKatex.default ?? markdownItKatex, { enableFencedBlocks: true, throwOnError: false });

// 區塊公式補上 data-line，讓同步捲動能定位
for (const rule of ['math_block', 'math_inline_block']) {
  const render = md.renderer.rules[rule];
  md.renderer.rules[rule] = (tokens, idx, ...rest) => {
    const line = tokens[idx].map?.[0];
    const html = render(tokens, idx, ...rest);
    return line === undefined ? html : html.replace('<p class="katex-block', `<p data-line="${line}" class="katex-block`);
  };
}

// 在每個區塊元素加上 data-line（原始碼行號，0 起算），供同步捲動使用
md.core.ruler.push('source_line', (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting >= 0 && token.block) {
      token.attrSet('data-line', String(token.map[0]));
    }
  }
});

// ```mermaid 區塊先輸出原始碼，renderPreview 之後再非同步繪製成 SVG
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0].toLowerCase();
  if (lang === 'mermaid') {
    return `<div class="mermaid-block" data-line="${token.attrGet('data-line')}"><pre class="mermaid-source">${md.utils.escapeHtml(token.content)}</pre></div>\n`;
  }
  const html = defaultFence(tokens, idx, options, env, slf);
  // ```math 由 KaTeX 外掛輸出為 <p class="katex-block">，補上 data-line
  return lang === 'math'
    ? html.replace('<p class="katex-block', `<p data-line="${token.attrGet('data-line')}" class="katex-block`)
    : html;
};

// ---- Mermaid：延遲載入、依原始碼快取結果 ----
let mermaidLoader = null;
const diagramCache = new Map(); // 主題 + 原始碼 → { svg } 或 { error }
let diagramSeq = 0;
let mermaidTheme = null;

// 目前介面主題（深色時圖表也用深色）
export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

async function loadMermaid(theme) {
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => mermaid);
  const mermaid = await mermaidLoader;
  if (mermaidTheme !== theme) {
    mermaidTheme = theme;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: theme === 'dark' ? 'dark' : 'default',
      fontFamily: '"Segoe UI", "Microsoft JhengHei UI", "Microsoft JhengHei", sans-serif',
    });
  }
  return mermaid;
}

function showDiagram(block, result) {
  if (result.svg) {
    block.innerHTML = result.svg;
    block.classList.remove('mermaid-error');
    return;
  }
  block.classList.add('mermaid-error');
  const title = document.createElement('strong');
  title.textContent = t('mermaidError');
  const detail = document.createElement('pre');
  detail.textContent = result.error;
  block.replaceChildren(title, detail);
}

async function renderDiagrams(blocks, theme) {
  if (!blocks.length) return;
  for (const block of blocks) {
    if (!block.isConnected) return; // 已被新的預覽取代
    const source = block.textContent;
    const key = theme + '|' + source;
    let result = diagramCache.get(key);
    if (!result) {
      const id = `mermaid-${++diagramSeq}`;
      const mermaid = await loadMermaid(theme);
      try {
        result = { svg: (await mermaid.render(id, source)).svg };
      } catch (err) {
        result = { error: String(err?.message ?? err) };
        document.getElementById(id)?.remove();
        document.getElementById('d' + id)?.remove();
      }
      if (diagramCache.size > 200) diagramCache.delete(diagramCache.keys().next().value);
      diagramCache.set(key, result);
    }
    if (block.isConnected) showDiagram(block, result);
  }
}

const EXTERNAL_URL = /^[a-z][a-z0-9+.-]*:/i; // http:、https:、mailto:、data: …
const WINDOWS_PATH = /^[a-z]:[\\/]/i;

// 把本機圖片路徑改寫成 /__doc?p=...，由 Go 端讀檔
function localImageUrl(src) {
  let path = src;
  if (/^file:\/\//i.test(src)) {
    path = decodeURIComponent(src.replace(/^file:\/\/\/?/i, ''));
  } else if (!WINDOWS_PATH.test(src)) {
    if (EXTERNAL_URL.test(src) || src.startsWith('//')) return null;
    path = decodeURIComponent(src.split(/[?#]/)[0]);
  }
  return '/__doc?p=' + encodeURIComponent(path);
}

// 仿 GitHub 的標題錨點 id，讓文件內 [目錄](#標題) 連結可以跳轉
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

// 產生預覽 HTML 並放進 container；回傳的 Promise 在圖表都繪製完成後 resolve。
// theme：圖表配色（預設跟著介面主題；匯出時固定用 light）
export function renderPreview(container, source, theme = currentTheme()) {
  const html = DOMPurify.sanitize(md.render(source), {
    ADD_ATTR: ['data-line'],
    FORBID_TAGS: ['style', 'form'],
  });
  container.innerHTML = html;

  container.querySelectorAll('img[src]').forEach((img) => {
    const url = localImageUrl(img.getAttribute('src'));
    if (url) img.src = url;
  });

  const used = new Map();
  container.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
    const base = slugify(h.textContent) || 'section';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
  });

  container.querySelectorAll('pre > code').forEach((code) => code.classList.add('hljs'));

  // 已快取的圖表立即套用（打字時不閃爍），其餘非同步繪製
  const pending = [];
  container.querySelectorAll('.mermaid-block').forEach((block) => {
    const cached = diagramCache.get(theme + '|' + block.textContent);
    if (cached) showDiagram(block, cached);
    else pending.push(block);
  });
  return renderDiagrams(pending, theme);
}

// 取得預覽中各區塊的 [原始碼行號, 在 container 中的 Y 座標]，依行號排序
export function lineAnchors(container) {
  const top = container.getBoundingClientRect().top - container.scrollTop;
  const anchors = [];
  container.querySelectorAll('[data-line]').forEach((el) => {
    anchors.push([Number(el.dataset.line), el.getBoundingClientRect().top - top]);
  });
  anchors.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return anchors;
}
