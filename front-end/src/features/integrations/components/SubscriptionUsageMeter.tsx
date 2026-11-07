/**
 * STATE MACHINE: SubscriptionUsageMeter
 *
 *   [UNKNOWN]   no agent has reported usage → muted "7d" + empty track
 *   [OK]        "7d" + a bar filled to the % of the weekly quota left
 *   [EXHAUSTED] rate-limited or 0% left → red "7d" + a full red track
 *
 * Pure presentation of `usageMeterView`; the tooltip carries the 5h window,
 * reset times and any cooldown.
 */

import type { ComputeAccount } from '../types';
import { usageMeterView } from './subscriptionUsage';

const TRACK = {
  ok: 'bg-black/10 dark:bg-white/[0.12]',
  unknown: 'bg-black/[0.06] dark:bg-white/[0.07]',
  exhausted: 'bg-red-500/25 dark:bg-[#5b2a2a]',
} as const;

const LABEL = {
  ok: 'text-muted-foreground',
  unknown: 'text-muted-foreground/60',
  exhausted: 'text-red-600 dark:text-[#f0786b]',
} as const;

export default function SubscriptionUsageMeter({
  account,
}: {
  account: Pick<ComputeAccount, 'usage' | 'rateLimitedUntil'>;
}) {
  const view = usageMeterView(account);
  const fill = view.remainingPct ?? 0;
  return (
    <span
      className="flex shrink-0 items-center gap-2"
      title={view.title}
      data-testid="usage-meter"
      data-usage-tone={view.tone}
    >
      <span className={`text-[12px] tabular-nums ${LABEL[view.tone]}`}>7d</span>
      <span
        role="meter"
        aria-label={view.title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.remainingPct ?? undefined}
        className={`relative h-[5px] w-[72px] overflow-hidden rounded-full ${TRACK[view.tone]}`}
      >
        {view.tone === 'ok' && (
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-foreground/45 dark:bg-[#a3a3a3]"
            style={{ width: `${fill}%` }}
          />
        )}
      </span>
    </span>
  );
}
