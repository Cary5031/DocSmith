// 依副檔名判斷文件類型。
//   markdown：Markdown 編輯＋預覽
//   text：任何文字檔（程式碼依副檔名上色）
//   pdf / ebook：唯讀閱讀器
//   office：Word / Excel / PowerPoint，開啟時自動轉成 Markdown
//   unsupported：舊版二進位 Office 格式

export const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i;
export const PDF_EXT = /\.pdf$/i;
export const EBOOK_EXT = /\.(epub|mobi|azw3?|fb2|fbz|cbz)$/i;
export const OFFICE_EXT = /\.(docx|xlsx|xls|ods|pptx)$/i;
export const UNSUPPORTED_EXT = /\.(doc|ppt|rtf|odt|odp)$/i;
// 可以「轉為 Markdown」的非 Markdown 文件
export const CONVERTIBLE_EXT = /\.(pdf|html?|csv)$/i;

export function kindOf(path) {
  if (!path || MARKDOWN_EXT.test(path)) return 'markdown';
  if (PDF_EXT.test(path)) return 'pdf';
  if (EBOOK_EXT.test(path)) return 'ebook';
  if (OFFICE_EXT.test(path)) return 'office';
  if (UNSUPPORTED_EXT.test(path)) return 'unsupported';
  return 'text';
}

// 使用編輯器的類型（其餘為唯讀閱讀器）
export const isEditorKind = (kind) => kind === 'markdown' || kind === 'text';
