/**
 * STATE MACHINE: FastModeToggle
 *
 * [ON] <-- enabled: true (default for allowlisted accounts)
 *     |
 *     | (click)
 *     v
 * [OFF] <-- enabled: false
 *     |
 *     | (click)
 *     v
 * [ON]
 *
 * State:
 * - enabled: boolean (controlled by parent; query-box scoped, session-only, never persisted client-side)
 *
 * UI: Zap icon only on the query box (label lives in aria-label + tooltip). The
 * Fast Mode *button* enables LLM provider speed (Anthropic speed=fast / OpenAI
 * priority). DEMO-prompt cache replay is independent of this control.
 *
 * Gating: only rendered when canUseFastMode(operator) is true (admin id, admin
 * phone, or live impersonation — see fastModeAccounts.ts).
 * The value is threaded into the create-agent payload as fast_mode_cache_enabled
 * (historical field name; server maps it to provider_fast_mode / LLM speed).
 */

import { Zap } from 'lucide-react';
import { useCallback } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleToggle}
          aria-label={label}
          aria-pressed={enabled}
          data-state={enabled ? 'on' : 'off'}
          data-testid="fast-mode-toggle"
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors',
            enabled
              ? 'border-amber-500/70 bg-amber-400/20 text-amber-700 shadow-sm ring-1 ring-amber-400/40 dark:text-amber-200'
              : 'border-border bg-muted/50 text-muted-foreground',
          )}
        >
          <Zap className={cn('h-3.5 w-3.5', enabled && 'fill-current')} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] z-[100]">
        <div className="text-xs space-y-1">
          <p>
            <span className="font-semibold">Fast Mode {enabled ? 'on' : 'off'}.</span>{' '}
            {enabled
              ? 'LLM calls that support it use provider fast mode (Anthropic speed / OpenAI priority).'
              : 'Turn on to use provider fast mode on LLM calls that support it.'}
          </p>
          <p className="text-muted-foreground">
            Session-only; applies to the next agent you create. Demo prompt cache
            replay is separate and does not use this button.
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
