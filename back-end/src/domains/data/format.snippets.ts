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

export function formatSnippet(
  content: string,
  regex: RegExp,
  contextBefore: number,
  contextAfter: number,
  showLineNumbers: boolean
): string {
  const probe = new RegExp(regex.source, regex.flags.replace('g', ''));
  const match = probe.exec(content);
  const lines = content.split('\n');
  if (!match || match.index < 0) {
    return lines
      .slice(0, contextBefore + contextAfter + 1)
      .map((line, idx) => (showLineNumbers ? `${idx + 1}: ${line}` : line))
      .join('\n');
  }

  const startLine = content.slice(0, match.index).split('\n').length - 1;
  const endLine = content.slice(0, match.index + match[0].length).split('\n').length - 1;
  const from = Math.max(0, startLine - contextBefore);
  const to = Math.min(lines.length - 1, endLine + contextAfter);

  return lines
    .slice(from, to + 1)
    .map((line, idx) => (showLineNumbers ? `${from + idx + 1}: ${line}` : line))
    .join('\n');
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
