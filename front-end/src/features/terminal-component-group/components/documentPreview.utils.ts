/**
 * Pure helpers for classifying FilePointers and parsing tabular previews.
 * No React - side-effect free so blackbox tests can import them directly.
 */

import type { FilePointer } from '@/lib/api/types';

export type DocumentPreviewKind =
  | 'html'
  | 'image'
  | 'markdown'
  | 'text'
  | 'csv'
  | 'pdf'
  | 'spreadsheet'
  | 'numbers'
  | 'docx'
  | 'pptx'
  | 'download';

/** Previewable kinds with in-drawer content renderers (not download-only). */
export const PREVIEWABLE_DOCUMENT_KINDS: DocumentPreviewKind[] = [
  'html',
  'image',
  'markdown',
  'text',
  'csv',
  'pdf',
  'spreadsheet',
  'numbers',
  'docx',
  'pptx',
];

export type SpreadsheetPreview = {
  sheetNames: string[];
  activeSheet: string;
  rows: string[][];
};

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkdn'];
const MARKDOWN_MIME_TYPES = new Set(['text/markdown', 'text/x-markdown', 'application/markdown']);
const TEXT_EXTENSIONS = ['.txt', '.json', '.xml', '.log', '.yaml', '.yml'];
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-yaml',
  'text/yaml',
]);

const TYPE_LABELS: Array<{ test: (mime: string, name: string) => boolean; label: string }> = [
  {
    test: (m, n) => m.includes('html') || n.endsWith('.html') || n.endsWith('.htm'),
    label: 'HTML',
  },
  { test: (m) => m.startsWith('image/'), label: 'Image' },
  { test: (m, n) => m === 'application/pdf' || n.endsWith('.pdf'), label: 'PDF' },
  {
    test: (m, n) =>
      m.includes('spreadsheetml') ||
      m.includes('ms-excel') ||
      n.endsWith('.xlsx') ||
      n.endsWith('.xls') ||
      n.endsWith('.xlsm'),
    label: 'Excel',
  },
  { test: (m, n) => m.includes('apple.numbers') || n.endsWith('.numbers'), label: 'Numbers' },
  {
    test: (m, n) =>
      m.includes('wordprocessingml') ||
      m === 'application/msword' ||
      n.endsWith('.docx') ||
      n.endsWith('.doc'),
    label: 'Word',
  },
  {
    test: (m, n) =>
      m.includes('presentationml') ||
      m.includes('ms-powerpoint') ||
      n.endsWith('.pptx') ||
      n.endsWith('.ppt'),
    label: 'PowerPoint',
  },
  { test: (m, n) => m.includes('apple.pages') || n.endsWith('.pages'), label: 'Pages' },
  {
    test: (m, n) =>
      m === 'text/csv' ||
      m === 'text/tab-separated-values' ||
      n.endsWith('.csv') ||
      n.endsWith('.tsv'),
    label: 'CSV',
  },
  {
    test: (m, n) =>
      MARKDOWN_MIME_TYPES.has(m) || MARKDOWN_EXTENSIONS.some((ext) => n.endsWith(ext)),
    label: 'Markdown',
  },
  {
    test: (m, n) =>
      m.startsWith('text/') ||
      TEXT_MIME_TYPES.has(m) ||
      TEXT_EXTENSIONS.some((ext) => n.endsWith(ext)),
    label: 'Text',
  },
];

function isSpreadsheet(mime: string, name: string): boolean {
  return (
    mime.includes('spreadsheetml') ||
    mime.includes('ms-excel') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    name.endsWith('.xlsm')
  );
}

function isNumbers(mime: string, name: string): boolean {
  return mime.includes('apple.numbers') || name.endsWith('.numbers');
}

function isCsv(mime: string, name: string): boolean {
  return (
    mime === 'text/csv' ||
    mime === 'text/tab-separated-values' ||
    name.endsWith('.csv') ||
    name.endsWith('.tsv')
  );
}

/** OOXML .docx only - legacy CFB `.doc` is not a zip package and cannot be parsed here. */
function isDocx(mime: string, name: string): boolean {
  return mime.includes('wordprocessingml') || name.endsWith('.docx');
}

/** OOXML .pptx only - legacy CFB `.ppt` is not a zip package and cannot be parsed here. */
function isPptx(mime: string, name: string): boolean {
  return mime.includes('presentationml') || name.endsWith('.pptx');
}

/**
 * Harden untrusted HTML for iframe srcDoc previews.
 * Blocks network/subresource loads via CSP while allowing inline styles + data: images.
 * `allowInlineScripts` (Rose Desktop only) also lets the document's own inline
 * scripts run so generated games/apps work; every network and subresource load
 * stays blocked, and the iframe stays sandbox="allow-scripts" (opaque origin, no
 * access to the Rose session).
 */
export function hardenHtmlPreview(
  html: string,
  options: { allowInlineScripts?: boolean } = {},
): string {
  const scriptSrc = options.allowInlineScripts === true ? " script-src 'unsafe-inline';" : '';
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:;${scriptSrc} base-uri 'none'; form-action 'none'; frame-ancestors 'none';">`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${csp}`);
  }
  return `<!DOCTYPE html><html><head>${csp}</head><body>${html}</body></html>`;
}

/** Classify how a FilePointer should render inside the document preview drawer. */
export function documentPreviewKind(file: FilePointer): DocumentPreviewKind {
  const mime = (file.mime_type || '').toLowerCase();
  const name = (file.original_filename || '').toLowerCase();

  if (mime.includes('html') || name.endsWith('.html') || name.endsWith('.htm')) return 'html';
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)) return 'image';
  if (MARKDOWN_MIME_TYPES.has(mime) || MARKDOWN_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return 'markdown';
  }
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (isSpreadsheet(mime, name)) return 'spreadsheet';
  if (isNumbers(mime, name)) return 'numbers';
  if (isCsv(mime, name)) return 'csv';
  if (isDocx(mime, name)) return 'docx';
  if (isPptx(mime, name)) return 'pptx';
  if (
    mime.startsWith('text/') ||
    TEXT_MIME_TYPES.has(mime) ||
    TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))
  ) {
    return 'text';
  }
  return 'download';
}

/** Short human label for the file type chip in the drawer header. */
export function documentTypeLabel(file: FilePointer): string {
  const mime = (file.mime_type || '').toLowerCase();
  const name = (file.original_filename || '').toLowerCase();
  for (const entry of TYPE_LABELS) {
    if (entry.test(mime, name)) return entry.label;
  }
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : '';
  return ext || 'File';
}

/** Parse delimiter-separated text into a rectangular string grid. */
export function parseDelimitedTable(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (ch === '\r') continue;
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value.trim().length > 0));
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Build a spreadsheet preview from workbook bytes via SheetJS. */
export async function parseSpreadsheetBytes(
  bytes: ArrayBuffer,
  preferredSheet?: string,
): Promise<SpreadsheetPreview> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true });
  const sheetNames = workbook.SheetNames;
  if (sheetNames.length === 0) {
    return { sheetNames: [], activeSheet: '', rows: [] };
  }
  const activeSheet =
    preferredSheet && sheetNames.includes(preferredSheet) ? preferredSheet : sheetNames[0];
  const sheet = workbook.Sheets[activeSheet];
  const raw = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
  }) as unknown[][];
  const rows = raw.map((row) => (Array.isArray(row) ? row.map(cellToString) : [cellToString(row)]));
  return { sheetNames, activeSheet, rows };
}

/**
 * Extract a visual/text preview from an Apple Numbers package (.numbers is a zip).
 * Prefers QuickLook/Preview assets; falls back to any embedded CSV/TSV/text.
 */
export async function parseNumbersPackage(bytes: ArrayBuffer): Promise<{
  spreadsheet?: SpreadsheetPreview;
  previewImageUrl?: string;
  text?: string;
}> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);

  const imagePath = Object.keys(zip.files).find((path) =>
    /(^|\/)(preview|thumbnail|quicklook).*\.(png|jpe?g|webp)$/i.test(path),
  );
  let previewImageUrl: string | undefined;
  if (imagePath) {
    const blob = await zip.files[imagePath].async('blob');
    previewImageUrl = URL.createObjectURL(blob);
  }

  const csvPath = Object.keys(zip.files).find((path) => /\.(csv|tsv|txt)$/i.test(path));
  if (csvPath) {
    const text = await zip.files[csvPath].async('string');
    const delimiter = csvPath.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    const sheetName = csvPath.split('/').pop() || 'Sheet';
    return {
      spreadsheet: {
        sheetNames: [sheetName],
        activeSheet: sheetName,
        rows: parseDelimitedTable(text, delimiter),
      },
      previewImageUrl,
      text,
    };
  }

  try {
    const spreadsheet = await parseSpreadsheetBytes(bytes);
    if (spreadsheet.rows.length > 0) {
      return { spreadsheet, previewImageUrl };
    }
  } catch {
    // Numbers IWA is often unreadable by community SheetJS
  }

  return { previewImageUrl };
}

function stripXmlTags(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<a:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract readable plain text from a .docx (Office Open XML) package. */
export async function parseDocxPackage(bytes: ArrayBuffer): Promise<{ text: string }> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const docXml = zip.files['word/document.xml'];
  if (!docXml) {
    throw new Error('docx package missing word/document.xml');
  }
  const xml = await docXml.async('string');
  const text = stripXmlTags(xml);
  if (!text) {
    throw new Error('docx document contained no readable text');
  }
  return { text };
}

/** Extract readable plain text from a .pptx package (concatenated slide text). */
export async function parsePptxPackage(bytes: ArrayBuffer): Promise<{ text: string }> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (slidePaths.length === 0) {
    throw new Error('pptx package has no slides');
  }
  const parts: string[] = [];
  for (const path of slidePaths) {
    const xml = await zip.files[path].async('string');
    const slideText = stripXmlTags(xml);
    if (slideText) {
      parts.push(slideText);
    }
  }
  const text = parts.join('\n\n').trim();
  if (!text) {
    throw new Error('pptx slides contained no readable text');
  }
  return { text };
}
