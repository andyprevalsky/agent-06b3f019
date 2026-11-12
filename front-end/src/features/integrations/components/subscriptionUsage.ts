/**
 * Remaining subscription quota for one compute account, as the usage bar shows it.
 *
 * The 7-day window is the bar; the 5-hour window and full detail live in the
 * tooltip / aria. Values come from the agents that use the account (see the
 * lineage heartbeat in the backend), so an account no agent has used yet has no
 * measurement and is shown as unknown rather than full.
 *
 *   authoritative cooldown OR a window used up  → exhausted (red track) + visible
 *                                                 "resets <when>" (or "no reset info")
 *   non-authoritative cooldown (stall/backoff)  → cooling: last known fill + visible
 *                                                 "retry in 12m" / "paused until <when>"
 *   7d window reported                          → ok (fill = % remaining)
 *   nothing reported                            → unknown: "No data yet"
 *   ok/exhausted snapshot older than STALE_MS   → stale: dimmed fill, "as of 3h ago"
 *   a window whose reset time has passed counts as fully remaining
 *
 * Older backends send only `rateLimitedUntil`; it is read as a cooldown of
 * unknown authority (reason rate_limit) and shown as cooling, because that
 * column also holds invented defaults and stall backoffs.
 */

import type { ComputeAccount, ComputeCooldown, ComputeUsageWindow } from '../types';

export type UsageTone = 'ok' | 'exhausted' | 'cooling' | 'unknown';

/** Usage snapshots older than this (with no cooldown to explain them) are dimmed. */
export const STALE_USAGE_MS = 6 * 3_600_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export type UsageMeterAccount = Pick<ComputeAccount, 'usage' | 'rateLimitedUntil'> &
  Partial<Pick<ComputeAccount, 'cooldown' | 'nextResetAt'>>;

export interface UsageMeterView {
  /** 0-100 remaining in the 7-day window; null when nothing was reported. */
  remainingPct: number | null;
  tone: UsageTone;
  /** Snapshot is older than STALE_USAGE_MS: dim the fill. */
  stale: boolean;
  /** Short visible text beside the bar ("resets 3:49 PM", "No data yet"); null = none. */
  label: string | null;
  /** aria-valuetext of the meter. */
  valueText: string;
  /** Tooltip / accessible description, one fact per line. */
  title: string;
}

interface ActiveCooldown {
  until: number;
  reason: ComputeCooldown['reason'];
  /** null = an older backend that cannot say. */
  authoritative: boolean | null;
}

function parse(at: string | null | undefined): number {
  return at === null || at === undefined ? NaN : Date.parse(at);
}

function future(ms: number, now: number): number | null {
  return Number.isFinite(ms) && ms > now ? ms : null;
}

function remainingPct(window: ComputeUsageWindow | null, now: number): number | null {
  if (window === null) return null;
  if (window.resetsAt !== null && Date.parse(window.resetsAt) <= now) return 100;
  return Math.min(100, Math.max(0, 100 - window.usedPct));
}

function formatWhen(ms: number, now: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** Compact form for the visible label: time today, else "Nov 14". */
function formatShort(ms: number, now: number): string {
  const date = new Date(ms);
  if (new Date(now).toDateString() === date.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatAgo(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MINUTE))}m ago`;
  if (ms < 24 * HOUR) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / (24 * HOUR))}d ago`;
}

/** "retry in 12m" under an hour, else "paused until <when>". */
function coolingHint(until: number, now: number): string {
  const left = until - now;
  if (left < HOUR) return `retry in ${Math.max(1, Math.ceil(left / MINUTE))}m`;
  return `paused until ${formatWhen(until, now)}`;
}

function windowLine(
  name: string,
  window: ComputeUsageWindow | null,
  left: number | null,
  now: number,
): string | null {
  if (window === null || left === null) return null;
  const reset = future(parse(window.resetsAt), now);
  const resets = reset !== null ? ` · resets ${formatWhen(reset, now)}` : '';
  return `${name}: ${Math.round(left)}% left${resets}`;
}

function activeCooldown(account: UsageMeterAccount, now: number): ActiveCooldown | null {
  if (account.cooldown !== undefined) {
    if (account.cooldown === null) return null;
    const until = future(parse(account.cooldown.until), now);
    if (until === null) return null;
    return {
      until,
      reason: account.cooldown.reason,
      authoritative: account.cooldown.authoritative,
    };
  }
  const until = future(parse(account.rateLimitedUntil), now);
  return until === null ? null : { until, reason: 'rate_limit', authoritative: null };
}

function cooldownLine(cooldown: ActiveCooldown, now: number): string {
  const when = formatWhen(cooldown.until, now);
  if (cooldown.authoritative === true) return `Rate-limited until ${when}`;
  if (cooldown.authoritative === false) return `Paused until ${when} (${cooldown.reason} backoff)`;
  return `Rate-limited until ${when} (reset not confirmed)`;
}

export function usageMeterView(
  account: UsageMeterAccount,
  now: number = Date.now(),
): UsageMeterView {
  const cooldown = activeCooldown(account, now);
  const authoritative = cooldown !== null && cooldown.authoritative === true;
  const usage = account.usage ?? null;
  const sevenDay = usage?.sevenDay ?? null;
  const fiveHour = usage?.fiveHour ?? null;
  const weekLeft = remainingPct(sevenDay, now);
  const fiveLeft = remainingPct(fiveHour, now);
  const weekEmpty = weekLeft !== null && weekLeft <= 0;
  const fiveEmpty = fiveLeft !== null && fiveLeft <= 0;
  const exhausted = authoritative || weekEmpty || fiveEmpty;

  const observedAt = parse(usage?.observedAt);
  const age = Number.isFinite(observedAt) ? now - observedAt : NaN;
  const stale = cooldown === null && usage !== null && age > STALE_USAGE_MS;

  const lines = [
    cooldown !== null ? cooldownLine(cooldown, now) : null,
    windowLine('7d', sevenDay, weekLeft, now),
    windowLine('5h', fiveHour, fiveLeft, now),
    stale ? `as of ${formatAgo(age)}` : null,
  ].filter((line): line is string => line !== null);
  const title = lines.length > 0 ? lines.join('\n') : 'No usage reported yet';
  const asOf = stale ? `, as of ${formatAgo(age)}` : '';

  if (exhausted) {
    // Only provider-reported times count; a Rose backoff is never shown as a reset.
    const bindingReset = weekEmpty
      ? parse(sevenDay?.resetsAt)
      : fiveEmpty
        ? parse(fiveHour?.resetsAt)
        : NaN;
    const reset =
      future(parse(account.nextResetAt), now) ??
      (authoritative ? cooldown.until : null) ??
      future(bindingReset, now);
    let label = reset !== null ? `resets ${formatShort(reset, now)}` : 'no reset info';
    if (reset === null && cooldown !== null && !authoritative) {
      label = `${label} · ${coolingHint(cooldown.until, now)}`;
    }
    return {
      remainingPct: 0,
      tone: 'exhausted',
      stale,
      label,
      valueText:
        reset !== null
          ? `Quota used up, resets ${formatWhen(reset, now)}${asOf}`
          : `Quota used up, no reset info${asOf}`,
      title,
    };
  }

  if (cooldown !== null) {
    const hint = coolingHint(cooldown.until, now);
    return {
      remainingPct: weekLeft,
      tone: 'cooling',
      stale: false,
      label: hint,
      valueText:
        weekLeft === null
          ? `Paused, ${hint}; no usage data`
          : `Paused, ${hint}; ${Math.round(weekLeft)}% of weekly quota left`,
      title,
    };
  }

  if (weekLeft === null) {
    return {
      remainingPct: null,
      tone: 'unknown',
      stale,
      label: 'No data yet',
      valueText: 'No usage data yet',
      title,
    };
  }

  return {
    remainingPct: weekLeft,
    tone: 'ok',
    stale,
    label: null,
    valueText: `${Math.round(weekLeft)}% of weekly quota left${asOf}`,
    title,
  };
}
