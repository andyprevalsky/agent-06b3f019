/**
 * Gmail per-user quota: pacing and rate-limit classification.
 *
 *   caller ─► gmailPacerFor(token).take(units) ─► fetch ─► isGmailRateLimited(status, body)?
 *                  │ waits until the mailbox's                 │ yes → back off and retry
 *                  ▼ per-user budget has room                  │ no  → caller handles it
 *
 * Google meters every request against one per-user budget ("Units per minute
 * per user", 15,000 units/min) and signals exhaustion with HTTP 429 OR with
 * HTTP 403 reason `rateLimitExceeded` / `userRateLimitExceeded`. A full sync of
 * a 30k-message mailbox needs ~150k units, so it cannot finish in under ten
 * minutes; firing it faster only buys 403s.
 */

/** Google's per-user limit, in quota units per minute. */
export const GMAIL_USER_UNITS_PER_MINUTE = 15_000;
/** The share a sync may use; the rest stays free for live reads (OTP lookups, agent search). */
const SYNC_BUDGET_FRACTION = 0.8;

/** Quota cost per method (developers.google.com/gmail/api/reference/quota). */
export const GMAIL_UNITS = {
  messagesGet: 5,
  messagesList: 5,
  historyList: 2,
  getProfile: 1,
} as const;

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/** True when Google says the per-user (or per-project) rate limit was hit. */
export function isGmailRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  try {
    const parsed = JSON.parse(body) as { error?: { errors?: Array<{ reason?: string }> } };
    return (parsed.error?.errors ?? []).some((e) => RATE_LIMIT_REASONS.has(e.reason ?? ''));
  } catch {
    return false;
  }
}

/**
 * Spaces request starts so a run never spends more than its budget per minute.
 * Each `take(units)` reserves the next free slot and resolves when it arrives.
 */
export class GmailQuotaPacer {
  private nextAt = 0;
  private readonly msPerUnit: number;

  constructor(unitsPerMinute = GMAIL_USER_UNITS_PER_MINUTE * SYNC_BUDGET_FRACTION) {
    this.msPerUnit = 60_000 / unitsPerMinute;
  }

  /** True once every reserved slot has passed. */
  idle(): boolean {
    return this.nextAt <= Date.now();
  }

  async take(units: number): Promise<void> {
    const now = Date.now();
    const startAt = Math.max(now, this.nextAt);
    this.nextAt = startAt + units * this.msPerUnit;
    if (startAt > now) await new Promise((resolve) => setTimeout(resolve, startAt - now));
  }
}

/**
 * One pacer per mailbox (keyed by address, or by token when no address is known), shared by every caller in this process (a sync,
 * OTP lookups, agent reads), so concurrent callers split one budget instead of
 * each spending a full one. Entries whose reservations have all elapsed are
 * dropped once the map grows, so it stays bounded by the mailboxes active now.
 */
const pacers = new Map<string, GmailQuotaPacer>();
const PRUNE_AT = 1_000;

export function gmailPacerFor(mailboxKey: string): GmailQuotaPacer {
  let pacer = pacers.get(mailboxKey);
  if (pacer === undefined) {
    if (pacers.size >= PRUNE_AT) {
      for (const [token, p] of pacers) if (p.idle()) pacers.delete(token);
    }
    pacer = new GmailQuotaPacer();
    pacers.set(mailboxKey, pacer);
  }
  return pacer;
}

/**
 * A mailbox's credentials for a run that can outlive one access token (a
 * quota-paced full sync of a large mailbox runs past Google's one-hour token
 * lifetime). `key` names the mailbox so every caller and every refresh shares
 * one pacer budget; `refresh`, when present, mints a new token. A plain string
 * is a token with no mailbox key that cannot refresh.
 */
export interface RefreshableGmailAccess {
  key: string;
  token: string;
  refresh?: () => Promise<string>;
}
export type GmailAccess = string | RefreshableGmailAccess;

export function gmailToken(access: GmailAccess): string {
  return typeof access === 'string' ? access : access.token;
}

export function gmailPacerForAccess(access: GmailAccess): GmailQuotaPacer {
  return gmailPacerFor(typeof access === 'string' ? access : access.key);
}

const refreshing = new WeakMap<RefreshableGmailAccess, Promise<string>>();

/**
 * Replace a rejected token. Concurrent requests that saw the same expired token
 * share one refresh; a request whose token was already replaced just retries.
 * Returns false when the access cannot refresh.
 */
export async function refreshGmailAccess(access: GmailAccess, rejected: string): Promise<boolean> {
  if (typeof access === 'string' || access.refresh === undefined) return false;
  if (access.token !== rejected) return true;
  let pending = refreshing.get(access);
  if (pending === undefined) {
    pending = access.refresh().finally(() => refreshing.delete(access));
    refreshing.set(access, pending);
  }
  access.token = await pending;
  return true;
}
