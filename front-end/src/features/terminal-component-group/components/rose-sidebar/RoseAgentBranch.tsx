/** Each disclosure opens direct children only; off-screen roots do not subscribe. */
import { useEffect, useMemo, useState } from 'react';
import { useAgentTree, type TreeNode } from '@/hooks/useAgentTree';
import type { Agent } from '../../hooks';
import { agentRunStatus, type AgentRunStatus } from '../agentRunState';
import RoseAgentRow from './RoseAgentRow';
import RoseCodeAgentRow from './RoseCodeAgentRow';
import type { RoseAgentGroupsProps } from './RoseAgentGroups';

export type RoseAgentBranchSidebar = Pick<
  RoseAgentGroupsProps,
  | 'isExpanded'
  | 'selectedAgentId'
  | 'selectedCodeAgentId'
  | 'attentionAgentIds'
  | 'onSelectAgent'
  | 'actionsFor'
  | 'onMenuOpenChange'
  | 'codeAgentsFor'
  | 'onOpenCodeAgent'
  | 'observeRoot'
  | 'visibleRootIds'
>;

function childAgent(root: Agent, node: TreeNode): Agent {
  return {
    ...root,
    agent_id: node.agentId,
    goal: node.goal,
    title: null,
    status: node.status,
    temporal_workflow_id: null,
    pinned_at: null,
  };
}
function childStatus(agent: Agent): AgentRunStatus {
  // Tree children are spawned agents; ACTIVE is their actual workflow status.
  return agent.status === 'ACTIVE' || agent.status === 'STARTING_UP'
    ? { state: 'active', label: 'Working' }
    : agentRunStatus(agent);
}

export default function RoseAgentBranch({
  agent,
  indented,
  mobile = false,
  sidebar: s,
}: {
  agent: Agent;
  indented: boolean;
  mobile?: boolean;
  sidebar: RoseAgentBranchSidebar;
}) {
  const visible = s.visibleRootIds?.has(agent.agent_id) ?? s.isExpanded;
  const subscribed = visible || s.selectedAgentId === agent.agent_id;
  const liveTree = useAgentTree(subscribed ? agent.agent_id : null);
  const [cachedTree, setCachedTree] = useState(liveTree);
  useEffect(() => {
    if (liveTree.size) setCachedTree(liveTree);
  }, [liveTree]);
  const tree = liveTree.size ? liveTree : cachedTree;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const codes = s.codeAgentsFor(agent.agent_id);
  const { agents, children, counts } = useMemo(() => {
    const agents = new Map<string, Agent>([[agent.agent_id, agent]]);
    const children = new Map<string, string[]>();
    for (const node of tree.values()) {
      if (node.agentId === agent.agent_id) continue;
      agents.set(node.agentId, childAgent(agent, node));
      if (node.parentAgentId)
        children.set(node.parentAgentId, [
          ...(children.get(node.parentAgentId) ?? []),
          node.agentId,
        ]);
    }
    const codeCounts = new Map<string, number>();
    for (const code of codes)
      if (code.status === 'ACTIVE')
        codeCounts.set(code.owner_agent_id, (codeCounts.get(code.owner_agent_id) ?? 0) + 1);
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    const pending = [{ id: agent.agent_id, exit: false }];
    while (pending.length) {
      const { id, exit } = pending.pop()!;
      if (!exit) {
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push({ id, exit: true });
        for (const child of children.get(id) ?? []) pending.push({ id: child, exit: false });
        continue;
      }
      const row = agents.get(id);
      const status = row && (id === agent.agent_id ? agentRunStatus(row) : childStatus(row));
      counts.set(
        id,
        (status?.state === 'active' && !s.attentionAgentIds.has(id) ? 1 : 0) +
          (codeCounts.get(id) ?? 0) +
          (children.get(id) ?? []).reduce((sum, child) => sum + (counts.get(child) ?? 0), 0),
      );
    }
    return { agents, children, counts };
  }, [agent, tree, codes, s.attentionAgentIds]);
  function toggle(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.has(id)) next.add(id);
      else {
        const queue = [id];
        const seen = new Set<string>();
        while (queue.length) {
          const child = queue.pop()!;
          if (seen.has(child)) continue;
          seen.add(child);
          next.delete(child);
          queue.push(...(children.get(child) ?? []));
        }
      }
      return next;
    });
  }
  function render(id: string, depth: number, path: ReadonlySet<string>): React.ReactNode {
    const row = agents.get(id);
    if (!row || path.has(id)) return null;
    const childIds = children.get(id) ?? [];
    const ownedCodes = codes.filter((code) => code.owner_agent_id === id);
    const open = s.isExpanded && expanded.has(id);
    return (
      <div key={id}>
        <RoseAgentRow
          agent={row}
          mobile={mobile}
          isSelected={s.selectedCodeAgentId === null && s.selectedAgentId === id}
          isExpanded={s.isExpanded}
          indented={indented}
          depth={depth}
          activeAgentCount={counts.get(id)}
          hasChildren={childIds.length + ownedCodes.length > 0}
          childrenExpanded={open}
          onToggleChildren={() => toggle(id)}
          statusOverride={depth > 0 ? childStatus(row) : undefined}
          hasAttentionRequest={s.attentionAgentIds.has(id)}
          onClick={() => s.onSelectAgent(id)}
          actions={s.actionsFor(row)}
          onMenuOpenChange={s.onMenuOpenChange}
          rowRef={depth === 0 ? s.observeRoot(id) : undefined}
        />
        {open && (
          <div data-testid={`rose-agent-children-${id}`}>
            {childIds.map((child) => render(child, depth + 1, new Set(path).add(id)))}
            {ownedCodes.map((code) => (
              <RoseCodeAgentRow
                key={code.code_agent_id}
                codeAgent={code}
                isExpanded
                parentIndented={indented}
                depth={depth + 1}
                isSelected={s.selectedCodeAgentId === code.code_agent_id}
                onOpen={() => s.onOpenCodeAgent(code)}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
  return render(agent.agent_id, 0, new Set());
}
