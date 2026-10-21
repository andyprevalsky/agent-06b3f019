import { useId } from 'react';
import type { ProgressEstimate } from '@/lib/api/types';

/** STATE MACHINE: absent/zero -> outline; prediction > 0 -> proportional arc.
 * Only model predictions fill the ring; its rem-sized footprint matches status icons.
 */
export default function AgentProgressRing({ estimate }: { estimate: ProgressEstimate | null }) {
  const gradient = useId().replace(/:/g, '');
  const progress = estimate?.progress ?? 0;
  return (
    <span
      className="relative inline-grid h-3.5 w-3.5 flex-none place-items-center rounded-full bg-white dark:bg-[#262624]"
      role="img"
      aria-label="Working"
    >
      <svg
        className="absolute inset-0 h-full w-full"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        role="progressbar"
        aria-label="Predicted progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={estimate ? Math.round(progress * 100) : undefined}
        aria-valuetext={
          estimate ? `${Math.round(progress * 100)}% predicted` : 'Prediction pending'
        }
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgb(9,78,255)" />
            <stop offset="100%" stopColor="rgb(57,182,255)" />
          </linearGradient>
        </defs>
        <circle
          cx="7"
          cy="7"
          r="6"
          fill="none"
          stroke="rgb(9,78,255)"
          strokeOpacity="0.18"
          strokeWidth="1.5"
        />
        {progress > 0 && (
          <circle
            data-testid="prediction-arc"
            cx="7"
            cy="7"
            r="6"
            fill="none"
            stroke={`url(#${gradient})`}
            strokeWidth="1.5"
            pathLength="100"
            strokeDasharray={`${progress * 100} 100`}
            transform="rotate(-90 7 7)"
          />
        )}
      </svg>
    </span>
  );
}
