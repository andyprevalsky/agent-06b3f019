/**
 * STATE MACHINE: FastModeToggle
 *
 * [OFF] <-- enabled: false (default every session — label says Fast Mode Off)
 *     |
 *     | (click)
 *     v
 * [ON] <-- enabled: true (label says Fast Mode On; record/replay third-party responses)
 *     |
 *     | (click)
 *     v
 * [OFF]
 *
 * State:
 * - enabled: boolean (controlled by parent; query-box scoped, session-only, never persisted client-side)
 *
 * UI: icon-only trigger; accessible label still reports Fast Mode On/Off.
 *
 * Gating: only rendered when the current user is in FAST_MODE_USER_IDS (Andy / Tamy).
 * The value is threaded into the create-agent payload as `fastMode`; default off means
 * the cache is completely inert (no read, no write).
 */

import { Zap } from 'lucide-react';
import { useCallback } from 'react';
import { cn } from '@/lib/utils';

interface FastModeToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export default function FastModeToggle({ enabled, onChange }: FastModeToggleProps) {
  const handleToggle = useCallback(() => {
    onChange(!enabled);
  }, [enabled, onChange]);
  const label = enabled ? 'Fast Mode On' : 'Fast Mode Off';

  return (
    <button
      type="button"
      onClick={handleToggle}
      aria-label={label}
      aria-pressed={enabled}
      data-state={enabled ? 'on' : 'off'}
      data-testid="fast-mode-toggle"
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs transition-colors',
        enabled
          ? 'border-amber-500/70 bg-amber-400/20 text-amber-700 shadow-sm ring-1 ring-amber-400/40 dark:text-amber-200'
          : 'border-border bg-muted/50 text-muted-foreground',
      )}
    >
      <Zap className={cn('h-3.5 w-3.5', enabled && 'fill-current')} />
    </button>
  );
}
