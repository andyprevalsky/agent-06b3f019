/**
 * STATE MACHINE: CodeContainerStatus (the code-agent view's query box, top right)
 *
 * A small dot for whether the code agent's container (its code session's
 * sandbox) is on, with the plain state in a tooltip:
 *
 *   [AWAKE]     green, slow 3 s fade (steady under prefers-reduced-motion)
 *                 ← the task is spinning up / live (its transcript snapshot), or
 *                   the left bar's list says the session is leased by a task
 *   [STOPPED]   orange, steady ← the session is paused (resumes on the next message)
 *   [DESTROYED] red, steady    ← the session is retired (its sandbox is gone)
 *   [UNKNOWN]   no dot          ← no persistent session (Mac and legacy runs)
 *
 * Source of truth (codeContainerState.ts): the live transcript snapshot while the
 * task runs; afterwards the code-agents list's container_state (the backend's
 * CodeSession.state, read by the left bar: no request of its own) once that
 * list has seen the task end, else the session state the task's close reported.
 * Never inferred from text.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { CodeContainerState } from '@/lib/api/tree';
import { cn } from '@/lib/utils';

import { CONTAINER_LABEL } from './codeContainerState';

const DOT: Record<CodeContainerState, string> = {
  awake: 'bg-emerald-500',
  stopped: 'bg-orange-500',
  destroyed: 'bg-red-500',
};

export function CodeContainerStatus({ state }: { state: CodeContainerState | null }) {
  if (!state) return null;
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <span
          role="status"
          tabIndex={0}
          aria-label={CONTAINER_LABEL[state]}
          data-testid="code-container-status"
          data-state={state}
          className="flex h-5 w-3 items-center justify-center outline-none"
        >
          <span
            data-testid="code-container-dot"
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              DOT[state],
              state === 'awake' && 'code-container-blink',
            )}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="z-[100]">
        <p className="text-xs">{CONTAINER_LABEL[state]}</p>
      </TooltipContent>
    </Tooltip>
  );
}
