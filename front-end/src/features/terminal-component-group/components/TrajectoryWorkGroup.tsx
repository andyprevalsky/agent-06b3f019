/**
 * STATE MACHINE: TrajectoryWorkGroup
 *
 *   [RUNNING, COLLAPSED] -- click --> [RUNNING, EXPANDED] -- click --> [RUNNING, COLLAPSED]
 *          |                                 |
 *          | batch compresses                | batch compresses (same instance:
 *          v                                 v  expand state and history kept)
 *   [DONE, COLLAPSED]   <---- click ---->  [DONE, EXPANDED]
 *
 * RUNNING header: fixed-height live carousel (latest activity icon + label,
 *   ring for tool batches, live elapsed). EXPANDED swaps the icon for a chevron.
 * DONE header: chevron + "Worked for Xs" + activity count.
 * EXPANDED: the ordered history so far (completed and in-progress activities),
 *   paged 20 at a time; new activities append while it stays open.
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Lightbulb, LoaderCircle, MessagesSquare } from 'lucide-react';
import { getToolIcon } from '@/lib/toolIcons';
import { useBatchElapsed } from './useBatchElapsed';
import type { Message } from '../hooks';
import type { TrajectoryWorkGroup as Group } from './trajectoryWorkGroups';
import { workLabel } from '../hooks/codeSessionTurns';
const PAGE_SIZE = 20;
/** The folded rows' kinds and tool identity, matching the stock row's data-* attributes. */
function toolIdentity(group: Group) {
  const statuses = new Set<string>();
  let startPhase: 'plan' | 'execute' | undefined;
  for (const { message } of group.activities) {
    const tool = message.metadata?.toolName;
    if (typeof tool !== 'string') continue;
    const status = message.metadata?.toolStatus;
    statuses.add(typeof status === 'string' ? `${tool}:${status}` : tool);
    const phase = message.metadata?.startPhase;
    if (tool === 'cloud_agent' && (phase === 'plan' || phase === 'execute')) startPhase = phase;
  }
  const kinds = [...new Set(group.activities.map((activity) => activity.kind))].join(' ');
  return { statuses: [...statuses].join(' '), startPhase, kinds };
}
export function TrajectoryWorkGroup({
  group,
  renderMessage,
  indicator,
}: {
  group: Group;
  renderMessage: (message: Message) => ReactNode;
  indicator?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const running = group.status === 'running';
  const elapsed = useBatchElapsed(group.startedAt, running);
  const latest = group.activities.at(-1)!;
  const comms = group.activities.filter((activity) => activity.kind === 'comms').length;
  const toolName = String(latest.message.metadata?.toolName ?? '');
  const toolBatch = latest.kind === 'work' && !['cloud_agent', 'agent_init'].includes(toolName);
  const Icon =
    latest.kind === 'comms'
      ? MessagesSquare
      : latest.kind === 'thinking'
        ? Lightbulb
        : getToolIcon(toolName);
  const lastPage = Math.max(0, Math.ceil(group.activities.length / PAGE_SIZE) - 1);
  const activePage = Math.min(page, lastPage);
  const label = running ? latest.label : workLabel(group);
  const tools = toolIdentity(group);
  return (
    <div
      data-testid="trajectory-work-group"
      data-group-key={group.key}
      data-state={group.status}
      data-activity-kinds={tools.kinds}
      data-tool-statuses={tools.statuses || undefined}
      data-agent-start-phase={tools.startPhase}
      className="min-w-0"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden text-left text-sm text-muted-foreground"
      >
        {running && !expanded ? (
          latest.kind === 'thinking' && indicator ? null : (
            <Icon
              data-testid="trajectory-activity-icon"
              size={14}
              aria-hidden
              className="shrink-0"
            />
          )
        ) : expanded ? (
          <ChevronDown size={14} aria-hidden />
        ) : (
          <ChevronRight size={14} aria-hidden />
        )}
        <span
          data-testid="trajectory-activity-line"
          className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap"
        >
          <span
            key={running ? latest.key : group.status}
            data-activity-key={latest.key}
            className={running ? 'trajectory-activity-enter block truncate' : 'block truncate'}
          >
            {running && latest.kind === 'thinking' && indicator ? indicator : label}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs">
          {running ? (
            <>
              {toolBatch && (
                <LoaderCircle data-testid="tool-batch-progress-ring" size={12} aria-hidden />
              )}
              <span data-testid="trajectory-batch-elapsed">{elapsed}</span>
              {comms > 0 && <span>· {comms} exchanges</span>}
            </>
          ) : (
            `${group.activities.length} activities${comms > 0 ? ` · ${comms} exchanges` : ''}`
          )}
        </span>
      </button>
      {expanded && (
        <div
          data-testid="trajectory-work-history"
          className="mt-2 max-h-80 space-y-3 overflow-y-auto overscroll-contain border-l border-border pl-3"
        >
          {group.activities
            .slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE)
            .map(({ key, message }) => (
              <div key={key} data-testid="trajectory-history-entry">
                {renderMessage(message)}
              </div>
            ))}
          {lastPage > 0 && (
            <div className="flex gap-3 text-xs">
              <button
                type="button"
                disabled={activePage === 0}
                onClick={() => setPage(activePage - 1)}
              >
                Previous activities
              </button>
              <span>
                {activePage + 1} / {lastPage + 1}
              </span>
              <button
                type="button"
                disabled={activePage === lastPage}
                onClick={() => setPage(activePage + 1)}
              >
                Next activities
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
