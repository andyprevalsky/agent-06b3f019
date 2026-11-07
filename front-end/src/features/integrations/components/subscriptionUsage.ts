/**
 * Remaining subscription quota for one compute account, as the usage bar shows it.
 *
 * The 7-day window is the bar; the 5-hour window and the provider cooldown only
 * appear in the tooltip. Values come from the agents that use the account (see
 * the lineage heartbeat in the backend), so an account no agent has used yet
 * has no measurement and is shown as unknown rather than full.
 *
 *   rateLimitedUntil > now OR 7d remaining <= 0 → exhausted (red, full red track)
 *   7d window reported                          → ok (fill = % remaining)
 *   nothing reported                            → unknown (empty track)
 *   a window whose reset time has passed counts as fully remaining
 */

import type { ComputeAccount, ComputeUsageWindow } from '../types';

export type UsageTone = 'ok' | 'exhausted' | 'unknown';

export interface UsageMeterView {
  /** 0-100 remaining in the 7-day window; null when nothing was reported. */
  remainingPct: number | null;
  tone: UsageTone;
  /** Tooltip / accessible description, one fact per line. */
  title: string;
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

function windowLine(
  name: string,
  window: ComputeUsageWindow | null,
  left: number | null,
  now: number,
): string | null {
  if (window === null || left === null) return null;
  const reset = window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
  const resets = Number.isFinite(reset) && reset > now ? ` · resets ${formatWhen(reset, now)}` : '';
  return `${name}: ${Math.round(left)}% left${resets}`;
}

export function usageMeterView(
  account: Pick<ComputeAccount, 'usage' | 'rateLimitedUntil'>,
  now: number = Date.now(),
): UsageMeterView {
  const limitedUntil =
    account.rateLimitedUntil === null ? NaN : Date.parse(account.rateLimitedUntil);
  const limited = Number.isFinite(limitedUntil) && limitedUntil > now;
  const sevenDay = account.usage?.sevenDay ?? null;
  const fiveHour = account.usage?.fiveHour ?? null;
  const weekLeft = remainingPct(sevenDay, now);
  const lines = [
    limited ? `Rate-limited until ${formatWhen(limitedUntil, now)}` : null,
    windowLine('7d', sevenDay, weekLeft, now),
    windowLine('5h', fiveHour, remainingPct(fiveHour, now), now),
  ].filter((line): line is string => line !== null);
  const exhausted = limited || (weekLeft !== null && weekLeft <= 0);
  return {
    remainingPct: exhausted ? 0 : weekLeft,
    tone: exhausted ? 'exhausted' : weekLeft === null ? 'unknown' : 'ok',
    title: lines.length > 0 ? lines.join('\n') : 'No usage reported yet',
  };
}
