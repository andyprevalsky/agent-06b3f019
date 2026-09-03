/**
 * Pure helpers for classifying FilePointers in the summary document drawer.
 * No React — kept side-effect free so blackbox tests can import them directly.
 */

import type { FilePointer } from '../hooks';

export type DocumentPreviewKind = 'html' | 'image' | 'markdown' | 'text' | 'pdf' | 'download';

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkdn'];
const MARKDOWN_MIME_TYPES = new Set(['text/markdown', 'text/x-markdown', 'application/markdown']);
const TEXT_EXTENSIONS = ['.txt', '.csv', '.json', '.xml', '.log', '.tsv', '.yaml', '.yml'];
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-yaml',
  'text/yaml',
]);

const TYPE_LABELS: Array<{ test: (mime: string, name: string) => boolean; label: string }> = [
  { test: (m, n) => m.includes('html') || n.endsWith('.html') || n.endsWith('.htm'), label: 'HTML' },
  { test: (m) => m.startsWith('image/'), label: 'Image' },
  { test: (m, n) => m === 'application/pdf' || n.endsWith('.pdf'), label: 'PDF' },
  {
    test: (m, n) =>
      m.includes('spreadsheetml') ||
      m.includes('ms-excel') ||
      n.endsWith('.xlsx') ||
      n.endsWith('.xls'),
    label: 'Excel',
  },
  {
    test: (m, n) => m.includes('apple.numbers') || n.endsWith('.numbers'),
    label: 'Numbers',
  },
  {
    test: (m, n) =>
      m.includes('wordprocessingml') || m === 'application/msword' || n.endsWith('.docx') || n.endsWith('.doc'),
    label: 'Word',
  },
  {
    test: (m, n) =>
      m.includes('presentationml') || m.includes('ms-powerpoint') || n.endsWith('.pptx') || n.endsWith('.ppt'),
    label: 'PowerPoint',
  },
  { test: (m, n) => m.includes('apple.pages') || n.endsWith('.pages'), label: 'Pages' },
  { test: (m, n) => MARKDOWN_MIME_TYPES.has(m) || MARKDOWN_EXTENSIONS.some((ext) => n.endsWith(ext)), label: 'Markdown' },
  { test: (m, n) => m.startsWith('text/') || TEXT_MIME_TYPES.has(m) || TEXT_EXTENSIONS.some((ext) => n.endsWith(ext)), label: 'Text' },
];

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
