/**
 * STATE MACHINE: InboundAgentRow (a message that ARRIVED from another agent)
 *
 * Direction rule (prime-agent ↑ sent / ↓ received, codex collab cells):
 *   OUTBOUND (this agent acted: send_message_to_agent, kill_agent, wait_for, spawn,
 *     list_agents inside explore) → main's tool-chip / spawn / wait UI.
 *   INBOUND agent message → THIS row: "↓" lead-in, sky left accent, no
 *     tool-chip frame. Role may be USER or ASSISTANT.
 *   Child completions are NOT rendered (filtered from the trajectory): the
 *     spawn UI and the dock already show each child's final state.
 *
 * Bodies are Codex messages; only the Payload is shown (header lines stripped).
 *
 * [COLLAPSED] (default) -- click / Enter --> [EXPANDED] (message payload)
 * [EXPANDED] -- click --> [COLLAPSED]          Empty body → not toggleable.
 */
import { useState } from 'react';
import { ChevronRight, Mail } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Message } from '../../hooks';
import { MarkdownText } from '../MarkdownText';
import { buildAgentToolData } from '../message-bubble/agentToolData';

export function InboundAgentRow({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const data = buildAgentToolData(message);
  if (!data) return null;
  const canToggle = data.message.trim().length > 0;

  return (
    <div
      className="flex min-w-0 max-w-full flex-col border-l-2 border-sky-400/70 pl-3 dark:border-sky-500/60"
      data-testid="inbound-agent-row"
      data-direction="inbound"
    >
      <button
        type="button"
        className={cn(
          'flex min-w-0 max-w-full items-center gap-2 py-0.5 text-left text-sm',
          canToggle ? 'hover:opacity-80' : 'cursor-default',
        )}
        onClick={canToggle ? () => setExpanded((open) => !open) : undefined}
        aria-expanded={canToggle ? expanded : undefined}
        title={data.title}
      >
        <span className="shrink-0 text-muted-foreground" aria-label="received">
          ↓
        </span>
        <Mail className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" aria-label="Message" />
        <span className="min-w-0 truncate text-foreground" data-testid="inbound-agent-row-title">
          {data.title}
        </span>
        {canToggle && (
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90',
            )}
            aria-hidden="true"
          />
        )}
      </button>
      {expanded && canToggle && (
        <div className="min-w-0 max-w-full max-h-[300px] overflow-y-auto overflow-x-hidden pb-1 pt-0.5">
          <MarkdownText
            text={data.message}
            shouldAnimate={false}
            className="tool-message-markdown min-w-0 max-w-full text-sm text-muted-foreground"
          />
        </div>
      )}
    </div>
  );
}
