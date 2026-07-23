/**
 * STATE MACHINE: SimulatorToggle
 *
 * [OFF] <-- enabled: false (default every session — label says Simulator Off)
 *     |
 *     | (click)
 *     v
 * [ON] <-- enabled: true (label says Simulator On; starry-night style brightens)
 *     |
 *     | (click)
 *     v
 * [OFF]
 *
 * State:
 * - enabled: boolean (controlled by parent; query-box scoped, session-only, never persisted client-side)
 *
 * UI: icon-only trigger; accessible label still reports Simulator On/Off.
 * Hover shows an explanatory tooltip for the current state.
 *
 * Gating: only rendered for product administrators via SIMULATOR_USER_IDS.
 */

import { Sparkles } from 'lucide-react';
import { useCallback } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface SimulatorToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export default function SimulatorToggle({ enabled, onChange }: SimulatorToggleProps) {
  const handleToggle = useCallback(() => {
    onChange(!enabled);
  }, [enabled, onChange]);
  const label = enabled ? 'Simulator On' : 'Simulator Off';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleToggle}
          aria-label={label}
          aria-pressed={enabled}
          data-state={enabled ? 'on' : 'off'}
          data-testid="simulator-toggle"
          className={cn(
            'relative inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-md border text-xs transition-colors',
            enabled
              ? 'border-indigo-300/80 bg-[radial-gradient(circle_at_35%_25%,rgba(250,204,21,0.52),transparent_18%),linear-gradient(135deg,#0b1026_0%,#1d2b64_52%,#3b2f78_100%)] text-yellow-100 shadow-sm ring-1 ring-indigo-300/50'
              : 'border-indigo-950/20 bg-[linear-gradient(135deg,#111827_0%,#1e1b4b_58%,#312e81_100%)] text-indigo-200/75 opacity-80',
          )}
        >
          <Sparkles className={cn('h-3.5 w-3.5', enabled && 'fill-current')} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] z-[100]">
        <div className="text-xs space-y-1">
          <p>
            <span className="font-semibold">Simulator {enabled ? 'on' : 'off'}.</span>{' '}
            {enabled
              ? 'This run executes against the trace-grounded world model — provider and environment calls (browser, calls, messages, payments) are simulated instead of hitting real services.'
              : 'Turn on to run the agent against the trace-grounded world model instead of real third-party services.'}
          </p>
          <p className="text-muted-foreground">
            Session-only; applies to the next agent you create.
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
