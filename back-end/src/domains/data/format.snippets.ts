/**
 * Data domain formatting — pure string/snippet helpers shared by format.ts.
 * No DB or business logic.
 */

/** Format a date as a relative "time ago" string. */
export function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMins = Math.floor((now.getTime() - date.getTime()) / 60000);
  const diffHours = Math.floor((now.getTime() - date.getTime()) / 3600000);
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

export function valueToLine(label: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return `${label}: ${JSON.stringify(value)}`;
  return `${label}: ${String(value)}`;
}

/**
 * Lines one text record may contribute. Mirrors Claude Code Grep's default
 * content-mode head_limit, so a whole-record read stays bounded.
 */
export const MAX_SNIPPET_LINES = 250;

/** 0-based line index containing character `offset`. */
function lineIndexAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * ripgrep content mode over one record: every match with its -B/-A context,
 * overlapping windows merged, separate groups split by `--`. Multiline
 * patterns keep their whole span. Bounded by MAX_SNIPPET_LINES.
 */
export function formatSnippet(
  content: string,
  regex: RegExp,
  contextBefore: number,
  contextAfter: number,
  showLineNumbers: boolean
): string {
  const lines = content.split('\n');
  const render = (idx: number) => (showLineNumbers ? `${idx + 1}: ${lines[idx]}` : lines[idx]);
  const lineStarts: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    lineStarts.push(cursor);
    cursor += line.length + 1;
  }

  const probe = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
  );
  const windows: Array<[number, number]> = [];
  let covered = 0;
  for (let match = probe.exec(content); match !== null; match = probe.exec(content)) {
    if (match[0] === '') probe.lastIndex += 1;
    const startLine = lineIndexAt(lineStarts, match.index);
    const endLine = lineIndexAt(lineStarts, match.index + Math.max(match[0].length - 1, 0));
    const from = Math.max(0, startLine - contextBefore);
    const to = Math.min(lines.length - 1, endLine + contextAfter);
    const last = windows.length > 0 ? windows[windows.length - 1] : null;
    if (last !== null && from <= last[1] + 1) {
      covered += Math.max(0, to - last[1]);
      last[1] = Math.max(last[1], to);
    } else {
      windows.push([from, to]);
      covered += to - from + 1;
    }
    if (covered > MAX_SNIPPET_LINES) break;
    if (probe.lastIndex > content.length) break;
  }

  if (windows.length === 0) {
    return lines
      .slice(0, contextBefore + contextAfter + 1)
      .map((_, idx) => render(idx))
      .join('\n');
  }

  const out: string[] = [];
  let emitted = 0;
  for (const [from, to] of windows) {
    if (emitted >= MAX_SNIPPET_LINES) break;
    if (out.length > 0) out.push('--');
    for (let idx = from; idx <= to && emitted < MAX_SNIPPET_LINES; idx++) {
      out.push(render(idx));
      emitted++;
    }
  }
  if (covered > MAX_SNIPPET_LINES) {
    out.push(
      `... more matching lines omitted after ${MAX_SNIPPET_LINES}; narrow the pattern to see the rest.`
    );
  }
  return out.join('\n');
}

export function formatTransactionRowSnippet(
  content: string,
  regex: RegExp,
  showLineNumbers: boolean
): string {
  const probe = new RegExp(regex.source, regex.flags.replace('g', ''));
  const coreFields = new Set([
    'transaction_id',
    'institution',
    'account',
    'date',
    'status',
    'direction',
    'amount',
    'absolute_amount',
    'merchant',
    'name',
    'original_description',
    'category',
  ]);
  const lines = content.split('\n');
  const selectedIndexes = new Set<number>();

  lines.forEach((line, idx) => {
    const field = line.slice(0, line.indexOf(':'));
    if (coreFields.has(field) || probe.test(line)) {
      selectedIndexes.add(idx);
    }
  });

  return [...selectedIndexes]
    .sort((a, b) => a - b)
    .map((idx) => (showLineNumbers ? `${idx + 1}: ${lines[idx]}` : lines[idx]))
    .join('\n');
}

export function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return '';
}

export function metadataString(metadata: unknown, key: string): string | undefined {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
    return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function pathSegment(value: string): string {
  return value.replace(/^\/+|\/+$/g, '').replace(/[?#]/g, '_');
}

export function decimalToString(value: { toString(): string } | number | string): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : value.toString();
}
