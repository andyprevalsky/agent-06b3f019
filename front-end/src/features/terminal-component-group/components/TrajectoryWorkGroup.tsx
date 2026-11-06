/**
 * STATE MACHINE: TrajectoryWorkGroup
 *
 *   [RUNNING, COLLAPSED] -- click --> [RUNNING, EXPANDED] -- click --> [RUNNING, COLLAPSED]
 *          |      ^                          |      ^
 *  batch   |      | agent resumes   batch    |      | agent resumes
 * compresses      | (same batch)  compresses |      | (same batch)
 *          v      |                          v      |
 *   [DONE, COLLAPSED]   <---- click ---->  [DONE, EXPANDED]
 *   The same instance carries expand state and history across every transition.
 *
 * RUNNING header: fixed-height live carousel: disclosure chevron (→ collapsed,
 *   ↓ expanded), then the latest activity icon + label and the live elapsed; no
 *   spinner. Thinking always shows the ↓ token counter: the live stream's
 *   indicator, or the persisted thought's own size until the next stream starts.
 *   When the latest activity is a spawned agent, a smaller line beneath rotates
 *   through the tool(s) it is using now (SpawnedAgentToolLine).
 * DONE header: chevron + "Worked for Xs" + activity count.
 * EXPANDED: the ordered history so far (completed and in-progress activities),
 *   paged 20 at a time; opening a running batch shows its latest page, and new
 *   activities append while it stays open. The live elapsed clock is a leaf
 *   (BatchElapsed), so its 100 ms tick never re-renders the history rows.
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Lightbulb, MessagesSquare } from 'lucide-react';
import { getToolIcon } from '@/lib/toolIcons';
import { useAnimatedCounter } from '@/hooks/useAnimatedCounter';
import { useBatchElapsed } from './useBatchElapsed';
import { StreamingMetric } from './StreamingMetric';
import type { Message } from '../hooks';
import type { TrajectoryWorkGroup as Group } from './trajectoryWorkGroups';
import type { ExploreStep } from '../types';
import { SpawnedAgentToolLine } from './SpawnedAgentToolLine';
import { workLabel } from '../hooks/codeSessionTurns';
const PAGE_SIZE = 20;
/** Leaf clock: its tick re-renders only this text, never the open history rows. */
function BatchElapsed({ startedAt }: { startedAt: number | null }) {
  return <span data-testid="trajectory-batch-elapsed">{useBatchElapsed(startedAt, true)}</span>;
}
/** A persisted thought between streams keeps the ↓ counter, sized by its own text. */
function PersistedThinking({ message, label }: { message: Message; label: string }) {
  const tokens = Math.round(message.text.length / 4);
  return (
    <span className="flex items-center gap-2">
      {label}
      <StreamingMetric
        tokenCount={tokens}
        animatedTokenCount={useAnimatedCounter(tokens, 0.3)}
        className="text-xs"
        iconClassName="h-3 w-3"
        showZeroTokens
      />
    </span>
  );
}
/** The folded rows' kinds and tool identity, matching the stock row's data-* attributes. */
function toolIdentity(group: Group) {
  const statuses = new Set<string>();
  const kinds = new Set<string>();
  let comms = 0;
  let startPhase: 'plan' | 'execute' | undefined;
  for (const { message, kind } of group.activities) {
    kinds.add(kind);
    if (kind === 'comms') comms++;
    const tool = message.metadata?.toolName;
    if (typeof tool !== 'string') continue;
    const status = message.metadata?.toolStatus;
    statuses.add(typeof status === 'string' ? `${tool}:${status}` : tool);
    const phase = message.metadata?.startPhase;
    if (tool === 'cloud_agent' && (phase === 'plan' || phase === 'execute')) startPhase = phase;
  }
  return { statuses: [...statuses].join(' '), startPhase, kinds: [...kinds].join(' '), comms };
}
export function TrajectoryWorkGroup({
  group,
  renderMessage,
  indicator,
  exploreStepMap,
}: {
  group: Group;
  renderMessage: (message: Message) => ReactNode;
  indicator?: ReactNode;
  exploreStepMap?: ReadonlyMap<string, ExploreStep[]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const running = group.status === 'running';
  const historyId = useId();
  const latest = group.activities.at(-1)!;
  const tools = useMemo(() => toolIdentity(group), [group]);
  const comms = tools.comms;
  const toolName = String(latest.message.metadata?.toolName ?? '');
  const Icon =
    latest.kind === 'comms'
      ? MessagesSquare
      : latest.kind === 'thinking'
        ? Lightbulb
        : getToolIcon(toolName);
  const lastPage = Math.max(0, Math.ceil(group.activities.length / PAGE_SIZE) - 1);
  const activePage = Math.min(page, lastPage);
  const label = running ? latest.label : workLabel(group);
  const thinking = running && latest.kind === 'thinking';
  const liveThinking = thinking && indicator;
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
        aria-controls={expanded ? historyId : undefined}
        onClick={() => {
          if (!expanded && running) setPage(lastPage);
          setExpanded(!expanded);
        }}
        className="flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden text-left text-sm text-muted-foreground"
      >
        {expanded ? (
          <ChevronDown
            data-testid="trajectory-disclosure"
            size={14}
            aria-hidden
            className="shrink-0"
          />
        ) : (
          <ChevronRight
            data-testid="trajectory-disclosure"
            size={14}
            aria-hidden
            className="shrink-0"
          />
        )}
        {running && !liveThinking && (
          <Icon data-testid="trajectory-activity-icon" size={14} aria-hidden className="shrink-0" />
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
            {liveThinking ? (
              indicator
            ) : thinking ? (
              <PersistedThinking message={latest.message} label={label} />
            ) : (
              label
            )}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs">
          {running ? (
            <>
              <BatchElapsed startedAt={group.startedAt} />
              {comms > 0 && <span>· {comms} exchanges</span>}
            </>
          ) : (
            `${group.activities.length} activities${comms > 0 ? ` · ${comms} exchanges` : ''}`
          )}
        </span>
      </button>
      {running && !expanded && latest.kind === 'work' && (
        <SpawnedAgentToolLine
          key={latest.key}
          message={latest.message}
          exploreSteps={exploreStepMap?.get(latest.message.message_id)}
        />
      )}
      {expanded && (
        <div
          id={historyId}
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
