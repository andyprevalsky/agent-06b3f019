/** Mobile uses the browser sidebar's actual rows, tree disclosures and shared animations. */
import { Loader2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Agent } from '../../hooks';
import type { AgentRowHandlers } from '../SidebarAgentList';
import { matchesQuery, sortAgents } from '../agentListOrdering';
import { openCodeAgentFromRow, useCodeAgentView } from '../code-agent-view/codeAgentViewState';
import { useRoseAgentMenuActions } from './useRoseAgentMenuActions';
import { useRoseCodeAgents } from './useRoseCodeAgents';
import RoseAgentBranch from './RoseAgentBranch';

const NO_ACTIONS = {};
const NO_ATTENTION: ReadonlySet<string> = new Set();
export function RoseMobileAgentList({
  agents,
  selectedAgentId,
  onSelectAgent,
  onClose,
  handlers,
  attentionAgentIds = NO_ATTENTION,
  query,
  contentMatchAgentIds,
  isLoading,
  isSearching,
  searchError,
}: {
  agents: Agent[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  onClose: () => void;
  handlers: AgentRowHandlers;
  attentionAgentIds?: ReadonlySet<string>;
  query: string;
  contentMatchAgentIds: ReadonlySet<string>;
  isLoading: boolean;
  isSearching: boolean;
  searchError: string | null;
}) {
  const rows = sortAgents(
    agents.filter((a) => matchesQuery(a, query.trim().toLowerCase(), contentMatchAgentIds)),
    attentionAgentIds,
    false,
  );
  const code = useRoseCodeAgents(rows, selectedAgentId);
  const view = useCodeAgentView();
  const actionsFor = useRoseAgentMenuActions(handlers, NO_ACTIONS);
  return (
    <ScrollArea className="min-h-0 flex-1 text-foreground">
      <div data-testid="rose-mobile-agent-list" className="py-2">
        {searchError && (
          <p role="alert" className="px-5 py-2 text-sm text-destructive">
            {searchError}
          </p>
        )}
        {isLoading || isSearching ? (
          <div className="flex justify-center py-8">
            <Loader2 aria-label="Loading agents" className="h-5 w-5 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            {query ? 'No matching agents' : 'No agents yet'}
          </p>
        ) : (
          rows.map((agent) => (
            <RoseAgentBranch
              key={agent.agent_id}
              agent={agent}
              indented={false}
              sidebar={{
                isExpanded: true,
                selectedAgentId,
                selectedCodeAgentId: view?.openCodeAgent?.taskId ?? null,
                attentionAgentIds,
                onSelectAgent,
                actionsFor,
                onMenuOpenChange: () => {},
                ...code,
                onOpenCodeAgent: (row) => {
                  if (view) view.open(openCodeAgentFromRow(row));
                  else onSelectAgent(row.owner_agent_id);
                  onClose();
                },
              }}
            />
          ))
        )}
      </div>
    </ScrollArea>
  );
}
