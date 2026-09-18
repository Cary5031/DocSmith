// 各種文件格式轉 Markdown。函式庫都延遲載入，只有用到時才會載入。
import { ReadFile, ReadFileBase64, WriteBase64File } from '../wailsjs/go/main/App';


function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function readBytes(path) {
  return base64ToBytes(await ReadFileBase64(path));
}

function dirOf(path) {
  return path.replace(/[\\/][^\\/]*$/, '');
}

function baseName(path) {
  return path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

// 整理空行、補結尾換行
function tidy(markdown) {
  return markdown.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---- HTML（Word 也先轉成 HTML）----

let turndown = null;

async function getTurndown() {
  if (turndown) return turndown;
  const [{ default: TurndownService }, gfm] = await Promise.all([import('turndown'), import('@joplin/turndown-plugin-gfm')]);
  turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  turndown.use(gfm.gfm ?? gfm.default?.gfm);
  return turndown;
}

// Markdown 表格需要標題列、儲存格不能換段落：先整理成 GFM 能表達的樣子
function normalizeTables(root) {
  for (const table of root.querySelectorAll('table')) {
    const rows = [...table.querySelectorAll('tr')];
    if (!rows.length) continue;
    for (const cell of table.querySelectorAll('td, th')) {
      const paragraphs = [...cell.querySelectorAll('p')];
      paragraphs.forEach((p, i) => {
        if (i > 0) p.before(document.createElement('br'));
        p.replaceWith(...p.childNodes);
      });
    }
    if (!table.querySelector('th')) {
      const first = rows[0];
      for (const td of [...first.children]) {
        const th = document.createElement('th');
        th.append(...td.childNodes);
        td.replaceWith(th);
      }
    }
    if (!table.querySelector('thead')) {
      const thead = document.createElement('thead');
      thead.append(rows[0]);
      table.prepend(thead);
    }
  }
}

async function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, iframe, object, embed').forEach((el) => el.remove());
  normalizeTables(doc.body);
  // turndown 的清單寫成「-   項目」，整理成一般的「- 項目」
  return (await getTurndown()).turndown(doc.body).replace(/^(\s*)([-*]|\d+\.) {2,}/gm, '$1$2 ');
}

async function fromDocx(path, target) {
  const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
  const bytes = await readBytes(path);
  const dir = dirOf(path);
  let count = 0;
  const result = await mammoth.convertToHtml(
    { arrayBuffer: bytes.buffer },
    {
      // 內嵌圖片另存到「原檔名_images」資料夾，Markdown 以相對路徑引用
      convertImage: mammoth.images.imgElement(async (image) => {
        const ext = (image.contentType.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/^x-/, '');
        const name = `image${++count}.${ext}`;
        await WriteBase64File(`${dir}\\${target.assetsDir}\\${name}`, await image.read('base64'));
        return { src: encodeURI(`${target.assetsDir}/${name}`) };
      }),
    },
  );
  return htmlToMarkdown(result.value);
}

// ---- Excel / CSV ----

function markdownTable(rows) {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
  const [head, ...body] = rows.map((r) => Array.from({ length: width }, (_, i) => cell(r[i])));
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => ' --- ').join('|')}|`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

async function fromSpreadsheet(path, ext, title) {
  const XLSX = await import('xlsx');
  const workbook =
    ext === 'csv'
      ? XLSX.read((await ReadFile(path)).content, { type: 'string' })
      : XLSX.read(await readBytes(path), { type: 'array' });
  const parts = [`# ${title}`];
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
    if (ext !== 'csv') parts.push(`## ${name}`);
    if (rows.length) parts.push(markdownTable(rows));
  }
  return parts.join('\n\n');
}

// ---- PowerPoint ----

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

function paragraphsOf(node) {
  return [...node.getElementsByTagNameNS(NS_A, 'p')]
    .map((p) => ({
      level: Number(p.getElementsByTagNameNS(NS_A, 'pPr')[0]?.getAttribute('lvl') ?? 0),
      text: [...p.getElementsByTagNameNS(NS_A, 't')].map((t) => t.textContent).join('').trim(),
    }))
    .filter((p) => p.text);
}

async function fromPptx(path, title, slideLabel) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await readBytes(path));
  const number = (name) => Number(name.match(/slide(\d+)\.xml$/)[1]);
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => number(a) - number(b));
  const parser = new DOMParser();
  const out = [`# ${title}`];
  for (const [index, name] of slides.entries()) {
    const xml = parser.parseFromString(await zip.file(name).async('string'), 'application/xml');
    let slideTitle = '';
    const lines = [];
    for (const shape of xml.getElementsByTagNameNS(NS_P, 'sp')) {
      const type = shape.getElementsByTagNameNS(NS_P, 'ph')[0]?.getAttribute('type');
      const paragraphs = paragraphsOf(shape);
      if ((type === 'title' || type === 'ctrTitle') && !slideTitle) {
        slideTitle = paragraphs.map((p) => p.text).join(' ');
      } else if (type === 'subTitle') {
        lines.push(...paragraphs.map((p) => p.text), '');
      } else {
        lines.push(...paragraphs.map((p) => `${'  '.repeat(p.level)}- ${p.text}`));
      }
    }
    const tables = [...xml.getElementsByTagNameNS(NS_A, 'tbl')].map((tbl) =>
      markdownTable(
        [...tbl.getElementsByTagNameNS(NS_A, 'tr')].map((tr) =>
          [...tr.getElementsByTagNameNS(NS_A, 'tc')].map((tc) => paragraphsOf(tc).map((p) => p.text).join('<br>')),
        ),
      ),
    );
    out.push(`## ${slideTitle || `${slideLabel} ${index + 1}`}`);
    if (lines.length) out.push(lines.join('\n'));
    out.push(...tables);
  }
  return out.join('\n\n');
}

// ---- PDF（只抽文字）----

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;
// 項目符號（含 Word 輸出 PDF 時常見的 Symbol / Wingdings 私用區字元）
const BULLET = /^[•●○▪■□◆◇►‣⁃·\-–\uf000-\uf0ff]\s*/;

function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  return CJK.test(a.at(-1)) || CJK.test(b[0]) || a.endsWith(' ') || b.startsWith(' ') ? a + b : `${a} ${b}`;
}

async function fromPdf(path) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const pdf = await pdfjs.getDocument({ data: await readBytes(path), isEvalSupported: false, disableFontFace: true }).promise;

  // 1. 依 y 座標把文字片段組成行（記錄左右邊界，用來判斷是否為自動換行）
  const lines = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { items } = await page.getTextContent();
    const pageLines = [];
    let current = null;
    for (const item of items) {
      if (!('str' in item)) continue;
      const [, , c, d, x, y] = item.transform;
      const size = Math.round(Math.hypot(c, d) || item.height || 10);
      if (current && Math.abs(current.y - y) < size * 0.5) {
        // 同一行：片段之間有明顯空隙就補空格（例如表格欄位）
        if (x - current.right > size * 0.25 && !current.text.endsWith(' ')) current.text += ' ';
        current.text += item.str;
        current.size = Math.max(current.size, size);
        current.right = Math.max(current.right, x + item.width);
      } else if (item.str.trim()) {
        if (current) pageLines.push(current);
        current = { y, size, text: item.str, left: x, right: x + item.width };
      }
      if (item.hasEOL && current) {
        pageLines.push(current);
        current = null;
      }
    }
    if (current) pageLines.push(current);
    // 以左右對稱的版面邊界估算文字區右緣；寫到右緣附近的行代表是自動換行
    const pageWidth = page.getViewport({ scale: 1 }).width;
    const textRight = pageWidth - Math.min(pageWidth / 2, ...pageLines.map((l) => l.left));
    for (const l of pageLines) l.full = l.right >= textRight - l.size * 3;
    lines.push(...pageLines, { pageBreak: true });
  }

  // 2. 內文字級 = 字數最多的字級；比內文大的字級依大小對應成 # / ## / ###
  const weight = new Map();
  for (const l of lines) if (!l.pageBreak) weight.set(l.size, (weight.get(l.size) ?? 0) + l.text.length);
  const bodySize = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const headingSizes = [...weight.keys()].filter((s) => s >= bodySize * 1.15).sort((a, b) => b - a);
  const headingLevel = (size) => {
    const i = headingSizes.indexOf(size);
    return i < 0 ? 0 : Math.min(i + 1, 3);
  };

  // 3. 一般行距 = 相鄰內文行距的中位數；超過 1.3 倍視為段落間距
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const [a, b] = [lines[i - 1], lines[i]];
    if (!a.pageBreak && !b.pageBreak && a.size === bodySize && b.size === bodySize && a.y > b.y) gaps.push(a.y - b.y);
  }
  gaps.sort((a, b) => a - b);
  const lineGap = gaps[Math.floor(gaps.length / 2)] ?? bodySize * 1.5;

  // 4. 組段落
  const blocks = [];
  let paragraph = null;
  let prev = null;
  for (const line of lines) {
    if (line.pageBreak) {
      prev = null;
      continue;
    }
    const text = line.text.trim();
    const level = headingLevel(line.size);
    if (level && text.length < 100) {
      paragraph = null;
      blocks.push(`${'#'.repeat(level)} ${text}`);
    } else if (BULLET.test(text)) {
      paragraph = null;
      blocks.push(`- ${text.replace(BULLET, '')}`);
    } else {
      // 上一行寫滿整行寬（自動換行）且行距正常，才併成同一段
      const gap = prev ? prev.y - line.y : Infinity;
      if (paragraph !== null && prev?.full && gap > 0 && gap <= lineGap * 1.3) {
        blocks[blocks.length - 1] = joinText(blocks[blocks.length - 1], text);
      } else {
        blocks.push(text);
        paragraph = blocks.length - 1;
      }
    }
    prev = line;
  }
  // 相鄰的清單項目合成緊湊清單
  return blocks.join('\n\n').replace(/^(- .*)\n\n(?=- )/gm, '$1\n');
}

// ---- 入口 ----

// 轉換文件，回傳 Markdown；target 由 Go 端 ImportTargets 提供（圖片資料夾名稱）
export async function importDocument(path, target, labels) {
  const ext = path.split('.').pop().toLowerCase();
  const title = baseName(path);
  let markdown;
  switch (ext) {
    case 'docx':
      markdown = await fromDocx(path, target);
      break;
    case 'html':
    case 'htm':
      markdown = await htmlToMarkdown((await ReadFile(path)).content);
      break;
    case 'xlsx':
    case 'xls':
    case 'ods':
    case 'csv':
      markdown = await fromSpreadsheet(path, ext, title);
      break;
    case 'pptx':
      markdown = await fromPptx(path, title, labels.slide);
      break;
    case 'pdf':
      markdown = await fromPdf(path);
      break;
    default:
      throw new Error(`Unsupported format: .${ext}`);
  }
  return tidy(markdown);
}
