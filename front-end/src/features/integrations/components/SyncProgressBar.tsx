/**
 * STATE MACHINE: SyncProgressBar (Rose Desktop)
 *
 *   [INDETERMINATE]  progress null or pct null → full-width flowing gradient,
 *                    text "N <unit>" when a count exists, else "Syncing…"
 *   [DETERMINATE]    pct < 100 → bar width = pct (animated), moving shimmer,
 *                    "N of M <unit>" + "~ETA left" (ETA hidden when unknown)
 *   [DONE]           pct >= 100 → not rendered (the chip has flipped to synced)
 *
 * 4px track, rose→violet gradient (#ffb36b→#ff5f8f→#e43f9a→#9b4dff) with a
 * soft glow. Uses the existing `animate-shimmer` keyframes (tailwind config).
 */

import { useSyncProgress } from '../hooks/useSyncProgress';
import type { SyncProgress } from '../types';

export const SYNC_GRADIENT = 'linear-gradient(90deg,#ffb36b,#ff5f8f 45%,#e43f9a 70%,#9b4dff)';
const FLOWING_GRADIENT =
  'linear-gradient(90deg,#ffb36b,#ff5f8f,#e43f9a,#9b4dff,#e43f9a,#ff5f8f,#ffb36b)';
const SHIMMER = 'linear-gradient(90deg,transparent,rgba(255,255,255,.7),transparent)';
const GLOW = '0 0 8px rgba(255,95,143,.45)';

const fmt = (n: number) => n.toLocaleString('en-US');

/** "45 s", "4 min", "1 h 5 min". */
export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(seconds, 1)} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function ProgressText({ progress }: { progress: SyncProgress | null }) {
  if (progress === null || progress.done === null) return <span>Syncing…</span>;
  if (progress.total === null) {
    return (
      <span>
        <b className="font-semibold text-foreground">{fmt(progress.done)}</b> {progress.unit}
      </span>
    );
  }
  return (
    <span>
      <b className="font-semibold text-foreground">{fmt(progress.done)}</b> of{' '}
      {fmt(progress.total)} {progress.unit}
    </span>
  );
}

export function SyncProgressView({
  progress,
  prefix,
}: {
  progress: SyncProgress | null;
  /** Account label, shown when the integration has several accounts. */
  prefix?: string;
}) {
  if (progress !== null && progress.pct !== null && progress.pct >= 100) return null;
  const determinate = progress !== null && progress.pct !== null;
  const pct = determinate ? Math.round(progress.pct as number) : undefined;
  return (
    <div data-testid="sync-progress" data-state={determinate ? 'determinate' : 'indeterminate'}>
      <div
        role="progressbar"
        aria-label={prefix !== undefined ? `${prefix} sync progress` : 'Sync progress'}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={pct}
        className="relative h-1 overflow-hidden rounded bg-muted dark:bg-white/[0.08]"
      >
        {determinate ? (
          <div
            className="absolute inset-y-0 left-0 overflow-hidden rounded transition-[width] duration-700 ease-[cubic-bezier(.2,.8,.2,1)]"
            style={{ width: `${pct}%`, background: SYNC_GRADIENT, boxShadow: GLOW }}
          >
            <div
              aria-hidden="true"
              className="absolute inset-0 animate-shimmer motion-reduce:animate-none"
              style={{ backgroundImage: SHIMMER, backgroundSize: '200% 100%' }}
            />
          </div>
        ) : (
          <div
            aria-hidden="true"
            className="absolute inset-0 animate-shimmer rounded opacity-80 motion-reduce:animate-none"
            style={{ backgroundImage: FLOWING_GRADIENT, backgroundSize: '200% 100%', boxShadow: GLOW }}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between gap-3 text-[11.5px] tabular-nums text-muted-foreground">
        <span className="min-w-0 truncate">
          {prefix !== undefined && `${prefix} · `}
          <ProgressText progress={progress} />
        </span>
        {progress !== null && progress.etaSec !== null && progress.etaSec > 0 && (
          <span className="shrink-0">~{formatEta(progress.etaSec)} left</span>
        )}
      </div>
    </div>
  );
}

/** Progress bar for one syncing account, read through the single adapter. */
export default function SyncProgressBar({
  provider,
  accountId,
  prefix,
}: {
  provider: string;
  accountId: string;
  prefix?: string;
}) {
  const progress = useSyncProgress(provider, accountId);
  return <SyncProgressView progress={progress} prefix={prefix} />;
}
