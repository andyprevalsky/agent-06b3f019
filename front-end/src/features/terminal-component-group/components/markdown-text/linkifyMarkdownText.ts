/**
 * Bare-hostname linkify
 *
 *   LLM / tool text
 *     -> normalizeMarkdownText (unescape)
 *     -> linkifyMarkdownText (wrap bare hosts as [host](https://host))
 *     -> ReactMarkdown + remark-gfm
 *     -> <a href>  (both MarkdownText paths render the same ReactMarkdown tree)
 *
 * remark-gfm autolinkLiterals cover http(s):// and www. only. This pass
 * covers the rest of the hostname class (example.com, example.de/path)
 * without rewriting code, existing markdown links, or schemed URLs.
 *
 * Filename-like final labels (js, ts, json, py, md, …) stay plain text.
 */

// A fence closes only on a run of its own length (fenceTerminalOutput uses longer fences).
const PROTECTED_SEGMENT = /(`{3,})[\s\S]*?\1|`[^`]*`|\[[^\]]*\]\([^)]+\)|<[a-zA-Z][^>]*>/g;

const FILE_LIKE_TLDS = new Set([
  'js',
  'ts',
  'tsx',
  'jsx',
  'json',
  'py',
  'md',
  'txt',
  'yml',
  'yaml',
  'html',
  'htm',
  'css',
  'scss',
  'map',
  'lock',
  'toml',
  'rs',
  'go',
  'rb',
  'sh',
  'xml',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'c',
  'h',
  'cc',
  'cpp',
  'java',
  'kt',
  'swift',
  'php',
  'sql',
  'log',
  'conf',
  'cfg',
  'ini',
  'csv',
  'env',
]);

const BARE_HOST = new RegExp(
  String.raw`\b(?:www\.)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,24}(?:/[^\s<>\`'"()[\]{}]*)?`,
  'gi',
);

const TRAILING_PUNCT = /[.,;:!?]+$/;

function isAlreadyUrlContext(text: string, offset: number): boolean {
  const prev = text[offset - 1];
  return prev === '/' || prev === ':' || prev === '@' || prev === '=' || prev === '.';
}

function shouldLinkifyHost(raw: string): boolean {
  const host = raw.split('/')[0] ?? '';
  const labels = host.replace(/^www\./i, '').split('.');
  if (labels.length < 2) return false;
  const tld = (labels[labels.length - 1] ?? '').toLowerCase();
  if (FILE_LIKE_TLDS.has(tld)) return false;
  return !labels.every((label) => /^\d+$/.test(label));
}

function linkifyPlainText(text: string): string {
  return text.replace(BARE_HOST, (raw, offset: number, full: string) => {
    if (isAlreadyUrlContext(full, offset)) return raw;
    const trimmed = raw.replace(TRAILING_PUNCT, '');
    const trailing = raw.slice(trimmed.length);
    if (!trimmed || !shouldLinkifyHost(trimmed)) return raw;
    const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return `[${trimmed}](${href})${trailing}`;
  });
}

export function linkifyMarkdownText(text: string): string {
  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(PROTECTED_SEGMENT)) {
    const start = match.index ?? 0;
    parts.push(linkifyPlainText(text.slice(lastIndex, start)));
    parts.push(match[0]);
    lastIndex = start + match[0].length;
  }
  parts.push(linkifyPlainText(text.slice(lastIndex)));
  return parts.join('');
}
