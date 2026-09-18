// 自動排版：依文件類型選擇排版工具（全部內嵌、離線可用，延遲載入）。
import { FormatGo } from '../wailsjs/go/main/App';

// ---- 中英文間距（盤古之白）：中文與英數字之間加一個空格 ----
const CJK = '[\\u2e80-\\u2eff\\u2f00-\\u2fdf\\u3040-\\u309f\\u30a0-\\u30fa\\u30fc-\\u30ff\\u3100-\\u312f\\u3200-\\u32ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]';
const CJK_THEN_ANS = new RegExp(`(${CJK})([A-Za-z0-9])`, 'g');
const ANS_THEN_CJK = new RegExp(`([A-Za-z0-9])(${CJK})`, 'g');
// 不處理的片段：行內程式碼、連結網址、HTML 標籤、行內公式、網址
const PROTECTED = /(`+[^`]*`+|\]\([^)]*\)|<[^>\n]+>|\$[^$\n]+\$|https?:\/\/\S+)/g;

function spaceLine(line) {
  return line
    .split(PROTECTED)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(CJK_THEN_ANS, '$1 $2').replace(ANS_THEN_CJK, '$1 $2')))
    .join('');
}

// 對程式碼區塊、公式區塊以外的每一行加上中英文間距
function panguMarkdown(text) {
  let fence = null;
  let math = false;
  return text
    .split('\n')
    .map((line) => {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        if (!fence) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        return line;
      }
      if (fence) return line;
      if (/^\s*\$\$\s*$/.test(line)) {
        math = !math;
        return line;
      }
      return math ? line : spaceLine(line);
    })
    .join('\n');
}

// 純文字：去除行尾空白、連續空行最多保留一行、中英文間距、結尾換行
function formatPlainText(text) {
  const lines = text.split('\n').map((line) => spaceLine(line.replace(/[ \t]+$/, '')));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

// ---- Prettier ----
const PRETTIER_PARSERS = {
  md: ['markdown', 'markdown'],
  markdown: ['markdown', 'markdown'],
  mdown: ['markdown', 'markdown'],
  mkd: ['markdown', 'markdown'],
  js: ['babel', 'babel'],
  mjs: ['babel', 'babel'],
  cjs: ['babel', 'babel'],
  jsx: ['babel', 'babel'],
  ts: ['typescript', 'typescript'],
  mts: ['typescript', 'typescript'],
  cts: ['typescript', 'typescript'],
  tsx: ['typescript', 'typescript'],
  json: ['json', 'babel'],
  jsonc: ['json', 'babel'],
  json5: ['json5', 'babel'],
  css: ['css', 'postcss'],
  scss: ['scss', 'postcss'],
  less: ['less', 'postcss'],
  html: ['html', 'html'],
  htm: ['html', 'html'],
  vue: ['vue', 'html'],
  yaml: ['yaml', 'yaml'],
  yml: ['yaml', 'yaml'],
  graphql: ['graphql', 'graphql'],
  gql: ['graphql', 'graphql'],
};

const PRETTIER_PLUGINS = {
  markdown: () => import('prettier/plugins/markdown'),
  babel: () => Promise.all([import('prettier/plugins/babel'), import('prettier/plugins/estree')]),
  typescript: () => Promise.all([import('prettier/plugins/typescript'), import('prettier/plugins/estree')]),
  postcss: () => import('prettier/plugins/postcss'),
  html: () => Promise.all([import('prettier/plugins/html'), import('prettier/plugins/postcss'), import('prettier/plugins/babel'), import('prettier/plugins/estree')]),
  yaml: () => import('prettier/plugins/yaml'),
  graphql: () => import('prettier/plugins/graphql'),
};

async function prettierFormat(text, parser, pluginKey) {
  const [{ format }, plugins] = await Promise.all([import('prettier/standalone'), PRETTIER_PLUGINS[pluginKey]()]);
  return format(text, {
    parser,
    plugins: [plugins].flat(),
    printWidth: 100,
    proseWrap: 'preserve', // Markdown 段落不重新斷行
    endOfLine: 'lf',
  });
}

// ---- 其他格式 ----
async function formatSql(text) {
  const { format } = await import('sql-formatter');
  return format(text, { language: 'sql', tabWidth: 2, keywordCase: 'preserve' }) + '\n';
}

async function formatXml(text) {
  const { default: xmlFormat } = await import('xml-formatter');
  return xmlFormat(text, { indentation: '  ', collapseContent: true, lineSeparator: '\n' }) + '\n';
}

let ruffReady = null;
async function formatPython(text) {
  const ruff = await import('@wasm-fmt/ruff_fmt/vite');
  ruffReady ??= ruff.default();
  await ruffReady;
  return ruff.format(text);
}

let clangReady = null;
const CLANG_STYLES = { cs: 'Microsoft', java: 'Google', c: 'LLVM', h: 'LLVM', cpp: 'LLVM', cc: 'LLVM', cxx: 'LLVM', hpp: 'LLVM', hh: 'LLVM' };
async function formatClang(text, fileName, ext) {
  const clang = await import('@wasm-fmt/clang-format/vite');
  clangReady ??= clang.default();
  await clangReady;
  return clang.format(text, fileName, `{BasedOnStyle: ${CLANG_STYLES[ext]}, ColumnLimit: 120}`);
}

// 回傳 { text, tool }（tool 為工具名稱或介面字串的 key）；不支援的類型丟出 UNSUPPORTED
export async function formatDocument(path, kind, text) {
  const fileName = (path || 'untitled.md').split(/[\\/]/).pop();
  const ext = kind === 'markdown' && !path ? 'md' : (fileName.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
  // JSON：標準 JSON 一律展開成 2 格縮排；含註解等非標準寫法時交給 Prettier
  if (ext === 'json') {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2) + '\n', tool: 'JSON' };
    } catch {
      /* 非標準 JSON（例如含註解），下面用 Prettier 處理 */
    }
  }
  if (PRETTIER_PARSERS[ext]) {
    const [parser, plugin] = PRETTIER_PARSERS[ext];
    const source = parser === 'markdown' ? panguMarkdown(text) : text;
    return { text: await prettierFormat(source, parser, plugin), tool: parser === 'markdown' ? 'toolPrettierPangu' : 'Prettier' };
  }
  if (ext === 'sql') return { text: await formatSql(text), tool: 'sql-formatter' };
  if (['xml', 'svg', 'xaml', 'csproj', 'vbproj', 'props', 'targets', 'resx', 'config', 'xsd', 'xsl', 'xslt', 'plist'].includes(ext)) {
    return { text: await formatXml(text), tool: 'xml-formatter' };
  }
  if (ext === 'go') return { text: await FormatGo(text), tool: 'gofmt' };
  if (ext === 'py' || ext === 'pyi') return { text: await formatPython(text), tool: 'Ruff' };
  if (CLANG_STYLES[ext]) return { text: await formatClang(text, fileName, ext), tool: 'clang-format' };
  if (!ext || ['txt', 'text', 'log'].includes(ext)) return { text: formatPlainText(text), tool: 'toolPlainText' };
  throw new Error('UNSUPPORTED');
}
