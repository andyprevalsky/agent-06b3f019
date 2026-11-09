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
 *   spinner. An inbound agent message is an ordinary activity ("Message from …",
 *   mail icon); it never ends or re-keys the batch. Thinking is a stock activity
 *   like any tool (lightbulb + "Thinking"), never an animated indicator; a
 *   finished thought appends its recorded generation (duration · ↓ tokens ·
 *   tok/s, thoughtGeneration). Nothing is estimated from text length.
 *   When the latest activity is a spawned agent, a smaller line beneath rotates
 *   through the tool(s) it is using now (SpawnedAgentToolLine). A wait on agents
 *   reads "Waiting for <icon> Task Title" (WaitAgentTargets).
 * DONE header: chevron + "Worked for Xs" + activity count.
 * EXPANDED: the ordered history so far (completed and in-progress activities),
 *   paged 50 at a time, anchored at the newest activity (the latest page holds
 *   the 50 most recent); opening any batch (running or done) shows that page
 *   first, and new activities append while it stays open. The live elapsed clock is a leaf
 *   (BatchElapsed), so its 100 ms tick never re-renders the history rows.
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Lightbulb, MessagesSquare } from 'lucide-react';
import { getToolIcon } from '@/lib/toolIcons';
import { useBatchElapsed } from './useBatchElapsed';
import { useWorkHistoryPage, workHistoryPageSlice } from './useWorkHistoryPage';
import { thoughtGeneration } from './thoughtGeneration';
import { ThoughtGenerationMetric } from './ThoughtGenerationMetric';
import type { Message } from '../hooks';
import type { TrajectoryWorkGroup as Group } from './trajectoryWorkGroups';
import type { ExploreStep } from '../types';
import { SpawnedAgentToolLine } from './SpawnedAgentToolLine';
import { WaitAgentTargets } from './WaitAgentTargets';
import { waitAgentTargets } from './waitForPhrase';
import { workLabel } from '../hooks/codeSessionTurns';
import { AGENT_MESSAGE_TOOL_NAME, isInboundAgentMessage } from './message-bubble/agentToolData';
/** Leaf clock: its tick re-renders only this text, never the open history rows. */
function BatchElapsed({ startedAt }: { startedAt: number | null }) {
  return <span data-testid="trajectory-batch-elapsed">{useBatchElapsed(startedAt, true)}</span>;
}
/** A thought with a recorded generation shows it beside the label; otherwise just the label. */
function ThinkingLabel({ message, label }: { message: Message; label: string }) {
  const generation = thoughtGeneration(message.metadata);
  if (!generation) return <>{label}</>;
  return (
    <span className="flex items-center gap-2">
      {label}
      <ThoughtGenerationMetric generation={generation} />
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
  exploreStepMap,
}: {
  group: Group;
  renderMessage: (message: Message) => ReactNode;
  exploreStepMap?: ReadonlyMap<string, ExploreStep[]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { activePage, lastPage, setPage, openAtLatest } = useWorkHistoryPage(
    group.activities.length,
  );
  const running = group.status === 'running';
  const historyId = useId();
  const latest = group.activities.at(-1)!;
  const tools = useMemo(() => toolIdentity(group), [group]);
  const comms = tools.comms;
  const toolName = isInboundAgentMessage(latest.message)
    ? AGENT_MESSAGE_TOOL_NAME
    : String(latest.message.metadata?.toolName ?? '');
  const Icon =
    latest.kind === 'comms'
      ? MessagesSquare
      : latest.kind === 'thinking'
        ? Lightbulb
        : getToolIcon(toolName);
  const label = running ? latest.label : workLabel(group);
  const thinking = running && latest.kind === 'thinking';
  // Only a live wait reads "Waiting for …"; its final "Wait ended" / "Wait timed out"
  // row keeps the same targets but keeps its own label.
  const waitsOnAgents =
    running &&
    toolName === 'wait_for' &&
    latest.message.metadata?.toolStatus === 'IN_PROGRESS' &&
    waitAgentTargets(latest.message.metadata) !== null;
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
          if (!expanded) openAtLatest();
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
        {running && (
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
            {thinking ? (
              <ThinkingLabel message={latest.message} label={label} />
            ) : waitsOnAgents ? (
              <WaitAgentTargets metadata={latest.message.metadata} prefix="Waiting for" />
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
          {workHistoryPageSlice(group.activities, activePage).map(({ key, message }) => (
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
