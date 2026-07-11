/**
 * STATE MACHINE: TaskFlagIcons
 *
 *   props(simOn, fastOn) ──► render zero, one, or two static icons
 *     simOn  → <Sparkles> (same icon as the query-box SimulatorToggle)
 *     fastOn → <Zap>      (same icon as the query-box FastModeToggle)
 *   hover/focus(icon) → tooltip with the flag description (no other state).
 *     Each icon wrapper is keyboard-focusable (tabIndex=0) and mirrors the
 *     tooltip text as its aria-label for assistive tech.
 */

import { Sparkles, Zap } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

function FlagIcon({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex items-center cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label={label}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function TaskFlagIcons({ simOn, fastOn }: { simOn: boolean; fastOn: boolean }) {
  if (!simOn && !fastOn) return null;
  return (
    <span className="inline-flex items-center gap-1 ml-1.5 align-middle">
      {simOn && (
        <FlagIcon label="Simulated world model — the WMH intercepts every environment/tool boundary (no real side effects)">
          <Sparkles className="h-3.5 w-3.5 text-purple-500 fill-current" data-testid="flag-sim" />
        </FlagIcon>
      )}
      {fastOn && (
        <FlagIcon label="Fast mode — prompt caching enabled for this task's runs">
          <Zap className="h-3.5 w-3.5 text-amber-500 fill-current" data-testid="flag-fast" />
        </FlagIcon>
      )}
    </span>
  );
}
