/**
 * Stateless sidebar agent list.
 * Sorts agents (pinned first, then processing, then by recency) and renders the
 * scrollable list or empty/loading placeholders. All state is owned by the
 * parent (AppSidebar / MobileAgentDrawer / ArchivedAgentsDialog).
 */

import { Loader2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import AgentListItem from './AgentListItem';
import SidebarTooltip from './SidebarTooltip';
import { agentDisplayName } from './agentDisplayName';
import { agentRunStatus, type AgentRunState } from './agentRunState';
import { elapsedSince, elapsedTickIntervalMs } from './formatElapsed';
import { useNow } from './useNow';
import type { Agent } from '../hooks';

export interface AgentRowHandlers {
  onRenameAgent: (agent: Agent) => void;
  onCopyAgentLink: (agent: Agent) => void;
  onToggleAgentPin: (agent: Agent) => void;
  onArchiveAgent: (agent: Agent) => void;
  onRestoreAgent?: (agent: Agent) => void;
}

interface SidebarAgentListProps extends AgentRowHandlers {
  agents: Agent[];
  isLoadingAgents: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  isCollapsed: boolean;
  /** Rows come from the archive view: swap Archive for Restore. */
  isArchived?: boolean;
  emptyLabel?: string;
  /** Agent ids blocked on a user answer, from the app-wide attention subscription. */
  attentionAgentIds?: ReadonlySet<string>;
  /** Case-insensitive filter over the display name and the raw goal. */
  query?: string;
  /** IDs returned by server-side message-content search for the active query. */
  contentMatchAgentIds?: ReadonlySet<string>;
  isSearching?: boolean;
  searchError?: string | null;
}

function isPinned(agent: Agent): boolean {
  return agent.pinned_at !== null && agent.pinned_at !== undefined;
}

/**
 * Ordering weight per run state: what is blocked on YOU outranks what is running
 * on its own, which outranks what is already over. A needs-help row that sorted
 * below thirty active runs is a row you never see.
 */
const RUN_STATE_RANK: Record<AgentRunState, number> = {
  'needs-help': 0,
  active: 1,
  done: 2,
};

/**
 * Pinned first, then by run state (needs-help, active, done), then newest.
 *
 * The backend orders pinned-then-recent; re-sorting here adds the run-state tier
 * (which depends on client-only attention data) and keeps the list correct
 * between an optimistic pin toggle and the next refetch.
 */
export function sortAgents(
  agents: Agent[],
  attentionAgentIds: ReadonlySet<string>,
  isArchived: boolean,
): Agent[] {
  const rank = (a: Agent) =>
    RUN_STATE_RANK[
      agentRunStatus(a, { hasAttentionRequest: attentionAgentIds.has(a.agent_id), isArchived })
        .state
    ];

  return [...agents].sort((a, b) => {
    if (isPinned(a) !== isPinned(b)) return isPinned(a) ? -1 : 1;
    const byState = rank(a) - rank(b);
    if (byState !== 0) return byState;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

const NO_ATTENTION: ReadonlySet<string> = new Set<string>();
const NO_CONTENT_MATCHES: ReadonlySet<string> = new Set<string>();

/**
 * Match against BOTH the display name and the raw goal: a generated title is a
 * lossy summary, so searching for a word the user actually typed in their goal
 * must still find the run even when the title dropped that word.
 */
export function matchesQuery(
  agent: Agent,
  needle: string,
  contentMatchAgentIds: ReadonlySet<string>,
): boolean {
  if (needle === '') return true;
  if (contentMatchAgentIds.has(agent.agent_id)) return true;
  const haystack = `${agentDisplayName(agent)} ${agent.goal}`.toLowerCase();
  return haystack.includes(needle);
}

/**
 * Tick fast enough that the youngest active row stays truthful, and no faster.
 * A list whose newest run is a week old ticks every 5 minutes, not every second.
 */
function tickIntervalFor(agents: Agent[], activeIds: Set<string>, now: number): number {
  let interval = Number.POSITIVE_INFINITY;
  for (const agent of agents) {
    if (!activeIds.has(agent.agent_id)) continue;
    interval = Math.min(interval, elapsedTickIntervalMs(elapsedSince(agent.created_at, now)));
  }
  return Number.isFinite(interval) ? interval : 30_000;
}

/**
 * Filter -> sort -> split into pinned/rest, plus the list's single clock.
 *
 * Pulled out of the component so the render body stays readable; all of it is
 * derived state with no side effects beyond the one interval.
 */
function useAgentRows({
  agents,
  query,
  attentionAgentIds,
  isArchived,
  contentMatchAgentIds,
}: {
  agents: Agent[];
  query: string;
  attentionAgentIds: ReadonlySet<string>;
  isArchived: boolean;
  contentMatchAgentIds: ReadonlySet<string>;
}) {
  const needle = query.trim().toLowerCase();
  const visible = agents.filter((a) => matchesQuery(a, needle, contentMatchAgentIds));
  const sorted = sortAgents(visible, attentionAgentIds, isArchived);
  // Pinned rows get their own titled section. Archived rows never do — pinning
  // is about keeping a live run to hand, which an archived row is not.
  const pinnedRows = isArchived ? [] : sorted.filter(isPinned);
  const otherRows = isArchived ? sorted : sorted.filter((a) => !isPinned(a));

  const activeIds = new Set(
    agents
      .filter(
        (a) =>
          agentRunStatus(a, {
            hasAttentionRequest: attentionAgentIds.has(a.agent_id),
            isArchived,
          }).state === 'active',
      )
      .map((a) => a.agent_id),
  );
  // ONE clock for the whole list, and none at all when nothing is running.
  const now = useNow(tickIntervalFor(agents, activeIds, Date.now()), activeIds.size > 0);

  return { needle, sorted, pinnedRows, otherRows, now };
}

function SearchError({ message, isCollapsed }: { message: string | null; isCollapsed: boolean }) {
  if (message === null || isCollapsed) return null;
  return (
    <div role="alert" className="px-2 py-3 text-center text-sm text-destructive">
      {message}
    </div>
  );
}

export default function SidebarAgentList({
  agents,
  isLoadingAgents,
  selectedAgentId,
  onSelectAgent,
  isCollapsed,
  isArchived = false,
  emptyLabel = 'No agents yet',
  attentionAgentIds = NO_ATTENTION,
  query = '',
  contentMatchAgentIds = NO_CONTENT_MATCHES,
  isSearching = false,
  searchError = null,
  onRenameAgent,
  onCopyAgentLink,
  onToggleAgentPin,
  onArchiveAgent,
  onRestoreAgent,
}: SidebarAgentListProps) {
  const { needle, sorted, pinnedRows, otherRows, now } = useAgentRows({
    agents,
    query,
    attentionAgentIds,
    isArchived,
    contentMatchAgentIds,
  });
  const isEmpty = sorted.length === 0;
  const showSpinner = (isLoadingAgents && agents.length === 0) || (isSearching && isEmpty);
  const emptyText = needle === '' ? emptyLabel : 'No matching agents';

  const renderRow = (agent: Agent) => (
    <SidebarTooltip key={agent.agent_id} label={agentDisplayName(agent)} isCollapsed={isCollapsed}>
      <AgentListItem
        agent={agent}
        isSelected={selectedAgentId === agent.agent_id}
        onClick={() => onSelectAgent(agent.agent_id)}
        isCompact={isCollapsed}
        isArchived={isArchived}
        hasAttentionRequest={attentionAgentIds.has(agent.agent_id)}
        now={now}
        onRename={() => onRenameAgent(agent)}
        onCopyLink={() => onCopyAgentLink(agent)}
        onTogglePin={() => onToggleAgentPin(agent)}
        onArchive={() => onArchiveAgent(agent)}
        onRestore={onRestoreAgent === undefined ? undefined : () => onRestoreAgent(agent)}
      />
    </SidebarTooltip>
  );
  return (
    <ScrollArea className="flex-1">
      <div className={cn('py-2 space-y-1', isCollapsed ? 'px-1.5' : 'px-3')}>
        <SearchError message={searchError} isCollapsed={isCollapsed} />
        {showSpinner ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isEmpty && searchError === null ? (
          !isCollapsed && (
            <div className="text-center py-8 text-muted-foreground text-sm">{emptyText}</div>
          )
        ) : (
          <>
            {/* Header only when something is actually pinned — an empty
                "Pinned" label is just a wasted row. Hidden on the collapsed
                rail, which has no width for a section label. */}
            {pinnedRows.length > 0 && !isCollapsed && (
              <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">Pinned</div>
            )}
            {pinnedRows.map(renderRow)}
            {pinnedRows.length > 0 && otherRows.length > 0 && (
              <div className={cn('pb-1', isCollapsed ? 'pt-2' : 'pt-3')} aria-hidden="true">
                {isCollapsed && <div className="mx-auto h-px w-6 bg-border" />}
              </div>
            )}
            {otherRows.map(renderRow)}
          </>
        )}
      </div>
    </ScrollArea>
  );
}
