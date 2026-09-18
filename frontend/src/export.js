import { toPng, getFontEmbedCSS } from 'html-to-image';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, ImageRun,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, AlignmentType, LevelFormat,
} from 'docx';
import { renderPreview } from './preview.js';

const MAX_IMAGE_WIDTH = 600; // A4 內文寬度約 600px

// ---- 共用：在畫面外重新繪製文件（等圖表、圖片都完成）----
async function renderOffscreen(source) {
  const host = document.createElement('div');
  host.className = 'export-host theme-light'; // 匯出一律用淺色配色
  const article = document.createElement('article');
  article.className = 'markdown-body export-body';
  host.append(article);
  document.body.append(host);
  await renderPreview(article, source, 'light'); // 匯出一律用淺色圖表
  const loading = [...article.querySelectorAll('img')].filter((img) => !img.complete);
  await Promise.all(
    loading.map(
      (img) =>
        new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        }),
    ),
  );
  return { article, dispose: () => host.remove() };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function fetchDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return blobToDataUrl(await res.blob());
}

// ---- PDF：組出不依賴外部資源的 HTML，交給 Edge 列印 ----

// 收集頁面上所有 CSS；字型改成 data URI（只保留 woff2 以縮小檔案）
async function collectCss() {
  let css = '';
  for (const sheet of document.styleSheets) {
    let text = '';
    try {
      for (const rule of sheet.cssRules) text += rule.cssText + '\n';
    } catch {
      continue;
    }
    text = text.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\(["']?(?:woff|truetype)["']?\)/g, '');
    const base = sheet.href || location.href;
    const urls = new Set([...text.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:')));
    for (const u of urls) {
      try {
        text = text.split(u).join(await fetchDataUrl(new URL(u, base).href));
      } catch {
        /* 取不到的資源略過 */
      }
    }
    css += text;
  }
  return css;
}

const PRINT_CSS = `
@page { size: A4; margin: 16mm 15mm; }
html, body { height: auto !important; overflow: visible !important; display: block !important; background: #fff; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.markdown-body { max-width: none; margin: 0; padding: 0; font-size: 11pt; }
.markdown-body pre, .markdown-body pre code, .markdown-body pre code.hljs { white-space: pre-wrap; word-break: break-word; }
.markdown-body pre, .markdown-body tr, .markdown-body img, .markdown-body .mermaid-block, .markdown-body .katex-block, .markdown-body blockquote { break-inside: avoid; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 { break-after: avoid; }
.markdown-body table { display: table; width: auto; max-width: 100%; }
`;

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export async function buildHtml(source, title) {
  const { article, dispose } = await renderOffscreen(source);
  try {
    for (const img of article.querySelectorAll('img[src]')) {
      try {
        img.src = await fetchDataUrl(img.src);
      } catch {
        /* 外部或不存在的圖片保持原樣 */
      }
    }
    const css = await collectCss();
    return `<!DOCTYPE html>
<html lang="${document.documentElement.lang}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
<style>${PRINT_CSS}</style>
</head>
<body>
<article class="markdown-body">${article.innerHTML}</article>
</body>
</html>`;
  } finally {
    dispose();
  }
}

// ---- Word：DOM 轉 docx ----

// 圖片（任何瀏覽器可顯示的格式）轉 PNG
async function rasterize(src, width, height, scale = 2) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return { data: new Uint8Array(await blob.arrayBuffer()), width, height };
}

async function svgToPng(svg) {
  const rect = svg.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', width);
  clone.setAttribute('height', height);
  clone.style.maxWidth = 'none';
  const xml = new XMLSerializer().serializeToString(clone);
  return rasterize('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml), width, height);
}

async function imageToPng(img) {
  let width = img.naturalWidth;
  let height = img.naturalHeight;
  if (!width || !height) return null;
  const cap = 1600;
  if (width > cap) {
    height = (height * cap) / width;
    width = cap;
  }
  return rasterize(img.src, width, height, 1);
}

function imageRun(png) {
  let { width, height } = png;
  if (width > MAX_IMAGE_WIDTH) {
    height = (height * MAX_IMAGE_WIDTH) / width;
    width = MAX_IMAGE_WIDTH;
  }
  return new ImageRun({ type: 'png', data: png.data, transformation: { width: Math.round(width), height: Math.round(height) } });
}

function rgbToHex(color) {
  const m = color.match(/\d+/g);
  if (!m) return undefined;
  return m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
}

const HEADINGS = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
};
// 標題樣式：深色粗體、與預覽一致（覆寫 docx 預設的淺藍色）
const HEADING_STYLES = Object.fromEntries(
  [32, 28, 24, 22, 21, 21].map((size, i) => [
    `heading${i + 1}`,
    {
      run: { size, bold: true, color: i < 4 ? '1F2328' : '57606A' },
      paragraph: { spacing: { before: i < 2 ? 360 : 240, after: 120 }, keepNext: true },
    },
  ]),
);
const CODE_FONT = 'Consolas';
const CODE_FILL = 'F3F5F7';
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'D0D7DE' };

class DocxBuilder {
  constructor(fontEmbedCSS) {
    this.fontEmbedCSS = fontEmbedCSS;
    this.numbering = [];
    this.quoteDepth = 0;
  }

  async mathPng(el) {
    const rect = el.getBoundingClientRect();
    const dataUrl = await toPng(el, { pixelRatio: 3, backgroundColor: '#ffffff', fontEmbedCSS: this.fontEmbedCSS });
    const data = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
    return { data, width: rect.width, height: rect.height };
  }

  textRun(text, fmt) {
    return new TextRun({
      text,
      bold: fmt.bold,
      italics: fmt.italics,
      strike: fmt.strike,
      color: fmt.color,
      style: fmt.link ? 'Hyperlink' : undefined,
      font: fmt.code ? CODE_FONT : undefined,
      shading: fmt.code ? { type: ShadingType.CLEAR, fill: CODE_FILL, color: 'auto' } : undefined,
    });
  }

  // 行內內容 → TextRun / ImageRun / ExternalHyperlink 陣列
  async inline(node, fmt = {}) {
    const runs = [];
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent.replace(/\s+/g, ' ');
        if (text) runs.push(this.textRun(text, fmt));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      if (child.classList.contains('katex')) {
        runs.push(imageRun(await this.mathPng(child)));
        continue;
      }
      switch (tag) {
        case 'strong':
        case 'b':
          runs.push(...(await this.inline(child, { ...fmt, bold: true })));
          break;
        case 'em':
        case 'i':
          runs.push(...(await this.inline(child, { ...fmt, italics: true })));
          break;
        case 's':
        case 'del':
          runs.push(...(await this.inline(child, { ...fmt, strike: true })));
          break;
        case 'code':
          runs.push(...(await this.inline(child, { ...fmt, code: true })));
          break;
        case 'a': {
          const href = child.getAttribute('href') || '';
          const external = /^(https?|mailto):/i.test(href);
          const children = await this.inline(child, { ...fmt, link: external });
          if (external) runs.push(new ExternalHyperlink({ link: href, children }));
          else runs.push(...children);
          break;
        }
        case 'br':
          runs.push(new TextRun({ break: 1 }));
          break;
        case 'img': {
          const png = await imageToPng(child).catch(() => null);
          runs.push(png ? imageRun(png) : this.textRun(child.alt || '', fmt));
          break;
        }
        case 'input':
          runs.push(this.textRun(child.checked ? '☑ ' : '☐ ', fmt));
          break;
        default:
          runs.push(...(await this.inline(child, fmt)));
      }
    }
    return runs;
  }

  // 程式碼區塊：每行一個段落，保留語法上色
  codeBlock(pre, indent) {
    const lines = [[]];
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const color = rgbToHex(getComputedStyle(node.parentElement).color);
      node.textContent.split('\n').forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines[lines.length - 1].push(new TextRun({ text: part, font: CODE_FONT, size: 19, color }));
      });
    }
    if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
    return lines.map(
      (runs, i) =>
        new Paragraph({
          children: runs.length ? runs : [new TextRun({ text: '', font: CODE_FONT })],
          shading: { type: ShadingType.CLEAR, fill: CODE_FILL, color: 'auto' },
          spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 160 : 0, line: 260 },
          indent: indent ? { left: indent } : undefined,
        }),
    );
  }

  async table(el) {
    const rows = [...el.querySelectorAll('tr')];
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER, insideHorizontal: BORDER, insideVertical: BORDER },
      rows: await Promise.all(
        rows.map(
          async (tr) =>
            new TableRow({
              tableHeader: tr.parentElement.tagName === 'THEAD',
              children: await Promise.all(
                [...tr.children].map(async (cell) => {
                  const header = cell.tagName === 'TH';
                  const align = cell.style.textAlign;
                  return new TableCell({
                    shading: header ? { type: ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' } : undefined,
                    margins: { top: 60, bottom: 60, left: 100, right: 100 },
                    children: [
                      new Paragraph({
                        alignment: align === 'right' ? AlignmentType.RIGHT : align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
                        children: await this.inline(cell, header ? { bold: true } : {}),
                      }),
                    ],
                  });
                }),
              ),
            }),
        ),
      ),
    });
  }

  orderedReference(start) {
    const reference = `ol-${this.numbering.length + 1}`;
    this.numbering.push({
      reference,
      levels: Array.from({ length: 9 }, (_, level) => ({
        level,
        format: LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        alignment: AlignmentType.START,
        start: level === 0 ? start : 1,
        style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
      })),
    });
    return reference;
  }

  // 清單（含巢狀、任務清單）；li 內的第一段帶項目符號 / 編號，其餘段落只縮排
  async list(el, level, quoteIndent) {
    const ordered = el.tagName === 'OL';
    const reference = ordered ? this.orderedReference(el.start || 1) : null;
    const out = [];
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const task = li.classList.contains('task-list-item');
      let first = true;
      let pending = [];
      const paragraph = (children) => {
        const props = { children, indent: undefined };
        if (first && !task) {
          if (ordered) props.numbering = { reference, level };
          else props.bullet = { level };
        } else {
          props.indent = { left: 720 * (level + 1) + quoteIndent };
        }
        first = false;
        return new Paragraph(props);
      };
      const flush = async () => {
        if (!pending.length) return;
        const holder = document.createElement('span');
        pending.forEach((n) => holder.append(n.cloneNode(true)));
        pending = [];
        if (!holder.textContent.trim() && !holder.querySelector('img, .katex, input')) return;
        const runs = await this.inline(holder);
        if (runs.length) out.push(paragraph(runs));
      };
      for (const child of li.childNodes) {
        const tag = child.nodeType === Node.ELEMENT_NODE ? child.tagName.toLowerCase() : '';
        if (tag === 'ul' || tag === 'ol') {
          await flush();
          out.push(...(await this.list(child, level + 1, quoteIndent)));
        } else if (tag === 'p') {
          await flush();
          out.push(paragraph(await this.inline(child)));
        } else if (['pre', 'table', 'blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
          await flush();
          out.push(...(await this.blocks(child, 720 * (level + 1) + quoteIndent)));
        } else {
          pending.push(child);
        }
      }
      await flush();
    }
    return out;
  }

  // 區塊內容 → Paragraph / Table 陣列；indent 用於引用與清單內的區塊
  async blocks(node, indent = 0) {
    const out = [];
    const children = node.matches?.('pre, table') ? [node] : [...node.children];
    for (const el of children) {
      const tag = el.tagName.toLowerCase();
      const indentProps = indent ? { indent: { left: indent } } : {};
      if (HEADINGS[tag]) {
        out.push(new Paragraph({ heading: HEADINGS[tag], children: await this.inline(el) }));
      } else if (el.classList.contains('mermaid-block')) {
        const svg = el.querySelector('svg');
        if (svg) out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [imageRun(await svgToPng(svg))] }));
        else out.push(...this.codeBlock(el, indent));
      } else if (el.classList.contains('katex-block')) {
        const math = el.querySelector('.katex') ?? el;
        out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [imageRun(await this.mathPng(math))] }));
      } else if (tag === 'p') {
        const quote = this.quoteDepth ? { border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'D0D7DE', space: 8 } } } : {};
        out.push(new Paragraph({ children: await this.inline(el, this.quoteDepth ? { color: '57606A' } : {}), ...indentProps, ...quote }));
      } else if (tag === 'ul' || tag === 'ol') {
        out.push(...(await this.list(el, 0, indent)));
      } else if (tag === 'pre') {
        out.push(...this.codeBlock(el, indent));
      } else if (tag === 'blockquote') {
        this.quoteDepth++;
        out.push(...(await this.blocks(el, indent + 400)));
        this.quoteDepth--;
      } else if (tag === 'table') {
        out.push(await this.table(el));
        out.push(new Paragraph({ children: [] }));
      } else if (tag === 'hr') {
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D0D7DE', space: 1 } } }));
      } else {
        out.push(...(await this.blocks(el, indent)));
      }
    }
    return out;
  }
}

// 回傳 docx 的 base64 內容
export async function buildDocx(source, title) {
  const { article, dispose } = await renderOffscreen(source);
  try {
    const fontEmbedCSS = article.querySelector('.katex') ? await getFontEmbedCSS(article) : '';
    const builder = new DocxBuilder(fontEmbedCSS);
    const children = await builder.blocks(article);
    const doc = new Document({
      creator: 'DocSmith',
      title,
      styles: {
        default: {
          document: {
            run: { font: { ascii: 'Calibri', hAnsi: 'Calibri', cs: 'Calibri', eastAsia: 'Microsoft JhengHei' }, size: 22 },
            paragraph: { spacing: { after: 120, line: 300 } },
          },
          ...HEADING_STYLES,
        },
      },
      numbering: { config: builder.numbering },
      sections: [{ children }],
    });
    return await Packer.toBase64String(doc);
  } finally {
    dispose();
  }
}
