/**
 * STATE MACHINE: a browser/explore task from the already-subscribed owner tree.
 * [RUNNING] -> [PAUSED/FINISHED] (the branch moves it into Finished agents).
 * Click -> owner's conversation; browser tasks also open its Browser drawer.
 */
import { Globe, Search } from 'lucide-react';
import type { TreeNode } from '@/hooks/useAgentTree';
import AgentStatusIndicator from '../AgentStatusIndicator';
import type { AgentRunStatus } from '../agentRunState';
import { useRoseApps } from '../rose-apps/roseAppsState';

export default function RoseTaskAgentRow({
  node,
  type,
  ownerId,
  depth,
  indented,
  status,
  mobile = false,
  onSelectAgent,
}: {
  node: TreeNode;
  type: string;
  ownerId: string;
  depth: number;
  indented: boolean;
  status: AgentRunStatus;
  mobile?: boolean;
  onSelectAgent: (id: string) => void;
}) {
  const apps = useRoseApps();
  const Icon = type === 'browser' ? Globe : Search;
  return (
    <button
      type="button"
      data-testid={`rose-task-agent-row-${node.agentId}`}
      aria-label={node.goal}
      title={node.goal}
      onClick={() => {
        onSelectAgent(ownerId);
        if (type === 'browser') apps?.openAgentBrowserTab(ownerId);
      }}
      style={{ paddingLeft: 22 + (indented ? 12 : 0) + depth * 16 }}
      className="flex h-[34px] w-full items-center gap-3 pr-4 text-left text-[13px] text-muted-foreground hover:text-foreground"
    >
      <span className="relative inline-grid h-5 w-5 flex-none place-items-center">
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span className="absolute -right-1.5 -top-1">
          <AgentStatusIndicator status={status} seed={node.agentId} mobile={mobile} />
        </span>
      </span>
      <span className="min-w-0 truncate">{node.goal}</span>
    </button>
  );
}
