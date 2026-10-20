/**
 * STATE MACHINE: SyncProgressBar (Rose Desktop)
 *
 *   [INDETERMINATE]  progress null or pct null → full-width flowing gradient,
 *                    text "N <unit>" when a count exists, else "Syncing…"
 *   [DETERMINATE]    pct < 100 → bar width = pct (animated), moving shimmer,
 *                    "N of M <unit>" + "~ETA left" (ETA hidden when unknown);
 *                    a measured pct with no counts (WhatsApp) reads "N%"
 *   [DONE]           pct >= 100 → not rendered (the chip has flipped to synced)
 *   any state with progress.phase → "<phase> · " before the count text; Gmail
 *     and LinkedIn machine phases read as text (syncProgressFormat.phaseLabel)
 *   unit 'bytes' → sizes ("1.5 MB of 12 MB"), never a raw byte count
 *   no live progress → the caller's fallback (LinkedIn: the run's phase timeline)
 *
 * 4px track, rose→violet gradient (#ffb36b→#ff5f8f→#e43f9a→#9b4dff) with a
 * soft glow. Uses the existing `animate-shimmer` keyframes (tailwind config).
 */

import { useSyncProgress } from '../hooks/useSyncProgress';
import type { SyncProgress } from '../types';

import { formatBytes, formatEta, phaseLabel } from './syncProgressFormat';

export const SYNC_GRADIENT = 'linear-gradient(90deg,#ffb36b,#ff5f8f 45%,#e43f9a 70%,#9b4dff)';
const FLOWING_GRADIENT =
  'linear-gradient(90deg,#ffb36b,#ff5f8f,#e43f9a,#9b4dff,#e43f9a,#ff5f8f,#ffb36b)';
const SHIMMER = 'linear-gradient(90deg,transparent,rgba(255,255,255,.7),transparent)';
const GLOW = '0 0 8px rgba(255,95,143,.45)';

const fmt = (n: number) => n.toLocaleString('en-US');

function ProgressText({ progress }: { progress: SyncProgress | null }) {
  if (progress === null || progress.done === null) {
    // A measured percent without counts (WhatsApp) is still real progress.
    if (progress?.pct != null) {
      return <b className="font-semibold text-foreground">{Math.round(progress.pct)}%</b>;
    }
    return <span>Syncing…</span>;
  }
  if (progress.unit === 'bytes') {
    return (
      <span>
        <b className="font-semibold text-foreground">{formatBytes(progress.done)}</b>
        {progress.total !== null && ` of ${formatBytes(progress.total)}`}
      </span>
    );
  }
  if (progress.total === null) {
    return (
      <span>
        <b className="font-semibold text-foreground">{fmt(progress.done)}</b> {progress.unit}
      </span>
    );
  }
  return (
    <span>
      <b className="font-semibold text-foreground">{fmt(progress.done)}</b> of {fmt(progress.total)}{' '}
      {progress.unit}
    </span>
  );
}

export function SyncProgressView({
  progress,
  prefix,
  provider = '',
}: {
  progress: SyncProgress | null;
  /** Account label, shown when the integration has several accounts. */
  prefix?: string;
  /** Integration row name; selects readable text for its machine phases. */
  provider?: string;
}) {
  if (progress !== null && progress.pct !== null && progress.pct >= 100) return null;
  const determinate = progress !== null && progress.pct !== null;
  const phase = phaseLabel(provider, progress?.phase ?? null);
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
            style={{
              backgroundImage: FLOWING_GRADIENT,
              backgroundSize: '200% 100%',
              boxShadow: GLOW,
            }}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between gap-3 text-[11.5px] tabular-nums text-muted-foreground">
        <span className="min-w-0 truncate">
          {prefix !== undefined && `${prefix} · `}
          {phase !== null && <span data-testid="sync-phase">{phase} · </span>}
          <ProgressText progress={progress} />
        </span>
        {progress !== null && progress.etaSec !== null && progress.etaSec > 0 && (
          <span className="shrink-0">~{formatEta(progress.etaSec)} left</span>
        )}
      </div>
    </div>
  );
}

/** True when a live report carries nothing to show (no phase and no count). */
function isBlank(progress: SyncProgress | null): boolean {
  return progress === null || (progress.phase === null && progress.done === null);
}

/** Progress bar for one syncing account, read through the single adapter. */
export default function SyncProgressBar({
  provider,
  accountId,
  prefix,
  fallback = null,
}: {
  provider: string;
  accountId: string;
  prefix?: string;
  /** Shown while the live progress report is blank (e.g. a LinkedIn run's timeline). */
  fallback?: SyncProgress | null;
}) {
  const live = useSyncProgress(provider, accountId);
  const progress = isBlank(live) && fallback !== null ? fallback : live;
  return <SyncProgressView progress={progress} prefix={prefix} provider={provider} />;
}
