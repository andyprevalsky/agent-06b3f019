/**
 * STATE MACHINE: SubscriptionUsageMeter
 *
 *   [UNKNOWN]   no agent has reported usage → muted "7d" + faint track + "No data yet"
 *   [OK]        "7d" + a bar filled to the % of the weekly quota left
 *               (stale snapshot → dimmed fill; "as of …" in the tooltip)
 *   [EXHAUSTED] authoritative cooldown or a used-up window → red "7d" + a full red
 *               track + visible "resets 3:49 PM" / "resets Nov 14" / "no reset info"
 *   [COOLING]   Rose backoff (stall, default cooldown) → last known fill (or faint
 *               track) + visible "retry in 12m" / "paused until …"; never red
 *
 * Pure presentation of `usageMeterView`. The visible label is real text (iOS has
 * no hover tooltip); the tooltip and aria carry the 5h window and full detail.
 */

import { usageMeterView, type UsageMeterAccount } from './subscriptionUsage';

const TRACK = {
  ok: 'bg-black/10 dark:bg-white/[0.12]',
  cooling: 'bg-black/10 dark:bg-white/[0.12]',
  unknown: 'bg-black/[0.06] dark:bg-white/[0.07]',
  exhausted: 'bg-red-500/25 dark:bg-[#5b2a2a]',
} as const;

const LABEL = {
  ok: 'text-muted-foreground',
  cooling: 'text-muted-foreground',
  unknown: 'text-muted-foreground/60',
  exhausted: 'text-red-600 dark:text-[#f0786b]',
} as const;

export default function SubscriptionUsageMeter({
  account,
  now,
}: {
  account: UsageMeterAccount;
  /** Render clock; the owner re-renders on a tick so expired cooldowns flip. */
  now?: number;
}) {
  const view = usageMeterView(account, now);
  const showFill = (view.tone === 'ok' || view.tone === 'cooling') && view.remainingPct !== null;
  return (
    <span
      className="flex min-w-0 shrink-0 items-center gap-2"
      title={view.title}
      data-testid="usage-meter"
      data-usage-tone={view.tone}
      data-usage-stale={view.stale ? 'true' : undefined}
    >
      <span className={`text-[12px] tabular-nums ${LABEL[view.tone]}`} aria-hidden="true">
        7d
      </span>
      <span
        role="meter"
        aria-label={view.title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.remainingPct ?? undefined}
        aria-valuetext={view.valueText}
        className={`relative h-[5px] shrink-0 overflow-hidden rounded-full ${
          view.label === null ? 'w-[72px]' : 'w-[44px] sm:w-[72px]'
        } ${TRACK[view.tone]}`}
      >
        {showFill && (
          <span
            data-testid="usage-fill"
            className={`absolute inset-y-0 left-0 rounded-full bg-foreground/45 dark:bg-[#a3a3a3] ${
              view.stale || view.tone === 'cooling' ? 'opacity-50' : ''
            }`}
            style={{ width: `${view.remainingPct}%` }}
          />
        )}
      </span>
      {view.label !== null && (
        <span
          data-testid="usage-status"
          aria-hidden="true"
          className={`whitespace-nowrap text-[11px] tabular-nums ${LABEL[view.tone]}`}
        >
          {view.label}
        </span>
      )}
    </span>
  );
}
