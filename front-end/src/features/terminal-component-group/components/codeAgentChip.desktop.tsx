/**
 * STATE MACHINE: DesktopCodeAgentChip (Rose Desktop flag on AND metadata.code_agent present)
 *
 * The code agent's row in the root transcript. It folds into the surrounding
 * "Worked for …" history like every other tool row (no card, header, body or
 * bottom rows): the tool icon, the code agent's title, its state word, the
 * devbox usage bars while it runs, and its elapsed time.
 *
 *   [spinning_up | live | verifying] → "<title> · Running" + CodeResourcesIndicator
 *                                      (CPU · memory · disk) + running clock
 *   [completed]                      → "<title> · Completed" + duration
 *   [failed]                         → "<title> · Failed" (red) + duration
 *   [paused]                         → "<title> · Paused" + duration
 *
 * CLICK (with a view provider): opens this session's code-agent view (the code
 * agent's own conversation and query box); isolated renders have no click.
 *
 * FailureBox / PausedNote: the backend's failure / pause text, shown by the
 * code-agent view.
 */

import { type ReactNode } from 'react';

import { getToolIcon } from '@/lib/toolIcons';
import { cn } from '@/lib/utils';
import {
  codeAgentLabel,
  eventTimeMs,
  pausedNote,
  type CodeAgentMeta,
  type CodeAgentTranscriptEvent,
} from '../hooks/codeAgentContract';
import { useAgentContext } from '../hooks';
import { desktopChipState, formatElapsed, useNow } from '../hooks/codeAgentSteering';
import type { ClaudeCodeChipVM } from './claudeCodeChip.hooks';
import { useCodeAgentView } from './code-agent-view/codeAgentViewState';
import { CodeResourcesIndicator } from './CodeResourcesIndicator';

const MUTED = 'text-muted-foreground dark:text-[#a3a39d]';

/**
 * The backend's failure text verbatim (a LOCAL_TARGET_UNAVAILABLE message is
 * already the exact user-facing sentence); never re-worded on the client.
 */
export function FailureBox({
  meta,
  fallback,
  flush,
}: {
  meta: CodeAgentMeta;
  fallback: string | null;
  flush?: boolean;
}) {
  const body: ReactNode = meta.failure_message ?? fallback;
  if (!body) return null;
  return (
    <div
      className={`mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 ${flush ? '' : 'mx-3'}`}
    >
      <p
        data-testid="code-agent-failure"
        className="whitespace-pre-wrap text-sm text-red-600 dark:text-red-400"
      >
        {body}
      </p>
    </div>
  );
}

/** A paused session's one muted line (never red): the backend's text for the user. */
export function PausedNote({ meta, className }: { meta: CodeAgentMeta; className: string }) {
  const note = pausedNote(meta);
  if (!note) return null;
  return (
    <p data-testid="code-agent-paused-note" className={`text-[13px] ${MUTED} ${className}`}>
      {note}
    </p>
  );
}

/** Opens this session's code-agent view (its owner is the chat that holds the row). */
function useOpenViewAction(meta: CodeAgentMeta): (() => void) | null {
  const view = useCodeAgentView();
  const { selectedAgentId } = useAgentContext();
  if (view === null || !selectedAgentId || meta.task_id === 'pending') return null;
  return () =>
    view.open({
      taskId: meta.task_id,
      ownerAgentId: selectedAgentId,
      provider: meta.provider,
      title: meta.title ?? '',
      status: null,
    });
}

const STATE_WORD = {
  spinning_up: 'Running',
  live: 'Running',
  verifying: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  paused: 'Paused',
} as const;

interface DesktopCodeAgentChipProps {
  meta: CodeAgentMeta;
  vm: ClaudeCodeChipVM;
  events?: CodeAgentTranscriptEvent[];
  toolCallId?: string | undefined;
}

export function DesktopCodeAgentChip({ meta, vm }: DesktopCodeAgentChipProps) {
  const state = desktopChipState(meta, vm.chipState);
  const running = state === 'live' || state === 'verifying' || state === 'spinning_up';
  const now = useNow(running);
  const openView = useOpenViewAction(meta);
  const startedAt = eventTimeMs(meta.started_at);
  const endedAt = running ? now : (eventTimeMs(meta.ended_at) ?? null);
  const elapsed = startedAt !== null && endedAt !== null ? formatElapsed(endedAt - startedAt) : '';
  const Icon = getToolIcon('spawn_claude_code_agent');
  const title = meta.title || codeAgentLabel(meta.provider);
  return (
    <div
      role={openView ? 'button' : undefined}
      tabIndex={openView ? 0 : undefined}
      onClick={openView ?? undefined}
      onKeyDown={(event) => {
        if (openView && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          openView();
        }
      }}
      data-testid="code-agent-chip"
      data-code-agent-id={meta.task_id}
      data-code-agent-state={state}
      data-code-agent-target={meta.target}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 text-sm',
        MUTED,
        openView && 'cursor-pointer hover:text-foreground',
      )}
    >
      <Icon size={14} aria-hidden className="shrink-0" />
      <span data-testid="code-agent-title" className="min-w-0 truncate">
        {title}
      </span>
      <span
        data-testid="code-agent-state"
        className={cn('shrink-0', state === 'failed' && 'text-red-600 dark:text-red-400')}
      >
        · {STATE_WORD[state]}
      </span>
      <span className="flex-1" />
      {/* Its popover opens on click: the row's click must not also open the view. */}
      <span className="shrink-0" onClick={(event) => event.stopPropagation()}>
        <CodeResourcesIndicator taskId={meta.task_id} running={running} />
      </span>
      {elapsed && (
        <span data-testid="code-agent-elapsed" className="shrink-0 text-xs tabular-nums">
          {elapsed}
        </span>
      )}
    </div>
  );
}
