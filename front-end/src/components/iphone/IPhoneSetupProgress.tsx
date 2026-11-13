/**
 * STATE MACHINE: IPhoneSetupProgress (Integrations iPhone row + Phone app device view)
 *
 *   [STARTING]  setting_up, no setupProgress steps yet → flowing indeterminate bar,
 *               "Starting setup…"
 *   [STEPS]     setting_up with steps → bar width = done / total (animated, shimmer),
 *               "Setting up · N of M steps"; the floating variant lists every step
 *               under the bar: done ✓ | in_progress spinner | pending ○ | failed ✕
 *     --a step fails--> [FAILED] "<step> failed" (bar keeps its done fraction)
 *     --connection ready--> [READY] full bar, "Connected", every listed step ✓
 *
 *   variant inline   → the row bar under Integrations' iPhone row (muted text, no list)
 *   variant floating → small card hovering over the top of the Phone screen
 *
 * Styling is SyncProgressView's (rose→violet gradient, 4px track, shimmer).
 * Pure presentation: useIPhoneConnection owns the /iphone/connection polling.
 */
import { Check, Circle, Loader2, X } from 'lucide-react';

import { FLOWING_GRADIENT, GLOW, SHIMMER, SYNC_GRADIENT } from '@/components/ui/syncGradient';
import type { IPhoneConnection, IPhoneSetupStep } from '@/lib/api/iphone';

function iphoneSetupFraction(connection: IPhoneConnection) {
  const steps = connection.setupProgress?.steps ?? [];
  const ready = connection.status === 'ready';
  const total = steps.length;
  const done = ready ? total : steps.filter((step) => step.status === 'done').length;
  const pct = ready ? 100 : total > 0 ? Math.round((done / total) * 100) : null;
  return { steps, ready, total, done, pct };
}

function StepIcon({ status }: { status: IPhoneSetupStep['status'] }) {
  if (status === 'done') return <Check aria-hidden="true" className="h-3 w-3 text-[#ff7aa2]" />;
  if (status === 'in_progress')
    return <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin text-white" />;
  if (status === 'failed') return <X aria-hidden="true" className="h-3 w-3 text-red-300" />;
  return <Circle aria-hidden="true" className="h-2.5 w-2.5 text-white/40" />;
}

const STEP_WORD: Record<IPhoneSetupStep['status'], string> = {
  done: 'done',
  in_progress: 'in progress',
  pending: 'pending',
  failed: 'failed',
};

export function IPhoneSetupProgress({
  connection,
  variant,
}: {
  connection: IPhoneConnection;
  variant: 'inline' | 'floating';
}) {
  const { steps, ready, total, done, pct } = iphoneSetupFraction(connection);
  const floating = variant === 'floating';
  const failed = steps.find((step) => step.status === 'failed');
  const muted = floating ? 'text-white/70' : 'text-muted-foreground';
  const strong = floating ? 'text-white' : 'text-foreground';
  return (
    <div
      data-testid={floating ? 'iphone-setup-progress-floating' : 'iphone-setup-progress'}
      data-state={ready ? 'ready' : pct === null ? 'indeterminate' : 'determinate'}
      className={
        floating
          ? 'pointer-events-none absolute inset-x-3 top-3 z-30 rounded-2xl bg-black/70 px-3 py-2.5 text-white shadow-lg backdrop-blur-md'
          : undefined
      }
    >
      <div
        role="progressbar"
        aria-label="iPhone setup progress"
        aria-valuemin={pct === null ? undefined : 0}
        aria-valuemax={pct === null ? undefined : 100}
        aria-valuenow={pct ?? undefined}
        className={`relative h-1 overflow-hidden rounded ${floating ? 'bg-white/15' : 'bg-muted dark:bg-white/[0.08]'}`}
      >
        {pct === null ? (
          <div
            aria-hidden="true"
            className="absolute inset-0 animate-shimmer rounded opacity-80 motion-reduce:animate-none"
            style={{
              backgroundImage: FLOWING_GRADIENT,
              backgroundSize: '200% 100%',
              boxShadow: GLOW,
            }}
          />
        ) : (
          <div
            data-testid="iphone-setup-progress-fill"
            className="absolute inset-y-0 left-0 overflow-hidden rounded transition-[width] duration-700 ease-[cubic-bezier(.2,.8,.2,1)]"
            style={{ width: `${pct}%`, background: SYNC_GRADIENT, boxShadow: GLOW }}
          >
            <div
              aria-hidden="true"
              className="absolute inset-0 animate-shimmer motion-reduce:animate-none"
              style={{ backgroundImage: SHIMMER, backgroundSize: '200% 100%' }}
            />
          </div>
        )}
      </div>
      <p
        className={`mt-1 truncate text-[11.5px] tabular-nums ${muted}`}
        data-testid="iphone-setup-progress-text"
      >
        {ready ? (
          <b className={`font-semibold ${strong}`}>Connected</b>
        ) : failed !== undefined ? (
          <span className={floating ? 'text-red-300' : 'text-destructive dark:text-red-300'}>
            {failed.label} failed
          </span>
        ) : total === 0 ? (
          'Starting setup…'
        ) : (
          <>
            Setting up · <b className={`font-semibold ${strong}`}>{done}</b> of {total} steps
          </>
        )}
      </p>
      {floating && steps.length > 0 && (
        <ol className="mt-1.5 flex flex-col gap-1" aria-label="iPhone setup steps">
          {steps.map((step) => {
            const status = ready ? 'done' : step.status;
            return (
              <li
                key={step.key}
                data-testid={`iphone-setup-step-${step.key}`}
                data-status={status}
                className={`flex items-center gap-2 text-[11.5px] ${status === 'pending' ? 'text-white/55' : 'text-white'}`}
              >
                <span className="flex h-3 w-3 shrink-0 items-center justify-center">
                  <StepIcon status={status} />
                </span>
                <span className="min-w-0 truncate">{step.label}</span>
                <span className="sr-only">({STEP_WORD[status]})</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
