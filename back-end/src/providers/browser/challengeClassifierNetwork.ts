/** Network pinning helpers for challenge classification (split out of classifier). */
export const NETWORK_ENTRY_CAP = 600;

const URL_IN_TEXT_RE = /https?:\/\/[^\s)\]"'<>]+/gi;

export type NetworkSummaryEntry = {
  url?: string;
  name?: string;
  status?: number | null;
  statusText?: string | null;
  status_text?: string | null;
  durationMs?: number | null;
  duration_ms?: number | null;
  transferSize?: number | null;
  size_bytes?: number | null;
  response_body?: string | null;
  response_body_truncated?: boolean;
};

export function urlsCitedInRecoveryReason(recoveryReason?: string | null): string[] {
  const text = (recoveryReason || '').trim();
  if (!text) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(URL_IN_TEXT_RE)) {
    const raw = String(match[0] || '').replace(/[.,;]+$/, '');
    try {
      const parsed = new URL(raw);
      if (!parsed.hostname) continue;
      const normalized = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname || '/'}`;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      urls.push(normalized);
    } catch {
      /* ignore malformed URL tokens */
    }
  }
  return urls;
}

export function citedNetworkHosts(recoveryReason?: string | null): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const url of urlsCitedInRecoveryReason(recoveryReason)) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!host || seen.has(host)) continue;
      seen.add(host);
      hosts.push(host);
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

function entryMatchesCited(
  entry: NetworkSummaryEntry,
  citedUrls: string[],
  citedHosts: string[]
): boolean {
  const url = String(entry.url || entry.name || '').toLowerCase();
  if (!url) return false;
  for (const host of citedHosts) {
    if (url.includes(host)) return true;
  }
  for (const cited of citedUrls) {
    const needle = cited.toLowerCase();
    if (url.includes(needle) || needle.includes(url)) return true;
  }
  return false;
}

export function selectNetworkEntriesForClassifier(
  entries: NetworkSummaryEntry[],
  options?: { recoveryReason?: string | null; cap?: number }
): NetworkSummaryEntry[] {
  const cap = options?.cap ?? NETWORK_ENTRY_CAP;
  if (entries.length === 0) return [];
  const citedUrls = urlsCitedInRecoveryReason(options?.recoveryReason);
  const citedHostList = citedNetworkHosts(options?.recoveryReason);
  const pinned: NetworkSummaryEntry[] = [];
  const rest: NetworkSummaryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = String(entry.url || entry.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (entryMatchesCited(entry, citedUrls, citedHostList)) pinned.push(entry);
    else rest.push(entry);
  }
  const merged = [...pinned, ...rest];
  return merged.slice(0, cap);
}
