/**
 * Current page URL of one browser task, for the Browser drawer's address bar
 * (UI ledger row 74). Pure so it is unit-testable.
 *
 * Browser step messages carry the page they acted on in their metadata, either
 * top-level or under `auxiliary`: `current_url`, `final_url`, `target_url` or
 * `url` (the same keys the benchmark run records read). The latest message of
 * the task that names an http(s) URL wins; none → null.
 */

import type { Message } from '../../hooks';

const URL_KEYS = ['current_url', 'final_url', 'target_url', 'url'] as const;

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function urlIn(record: Record<string, unknown> | undefined): string | null {
  if (record === undefined) return null;
  for (const key of URL_KEYS) {
    const url = httpUrl(record[key]);
    if (url !== null) return url;
  }
  return null;
}

export function latestBrowserPageUrl(messages: Message[], taskId: string): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const metadata = messages[i].metadata as Record<string, unknown> | undefined;
    if (metadata?.task_id !== taskId) continue;
    const auxiliary = metadata.auxiliary;
    const url =
      urlIn(metadata) ??
      urlIn(typeof auxiliary === 'object' && auxiliary !== null ? (auxiliary as Record<string, unknown>) : undefined);
    if (url !== null) return url;
  }
  return null;
}

/** Split a URL into the bold host and the muted rest, as the address bar shows it. */
export function addressParts(url: string): { host: string; rest: string } {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
    return { host: parsed.host, rest };
  } catch {
    return { host: url, rest: '' };
  }
}
