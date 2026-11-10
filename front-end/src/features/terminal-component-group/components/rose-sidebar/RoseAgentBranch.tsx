/**
 * Each disclosure opens direct children only; off-screen roots do not subscribe.
 * Children (sub-agents and code agents together) sort like every sidebar list:
 * running first, then the most recent user message (or creation).
 * STATE MACHINE: tree/session status -> running children + Finished agents.
 * Paused/terminal children -> collapsed drawer -> click -> existing child rows.
 * Resume -> main list. An ancestor of running work stays outside the drawer.
 * Browser/explore tasks join the same list from the existing tree subscription.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CodeAgentListItem } from '@/lib/api/tree';
import { mergeProgressEstimate } from '@/lib/progressEstimate';
import { useAgentTree, type TreeNode } from '@/hooks/useAgentTree';
import type { Agent } from '../../hooks';
import { lastUserMessageTime, runStateRank } from '../agentListOrdering';
import { agentRunStatus, type AgentRunStatus } from '../agentRunState';
import RoseAgentRow from './RoseAgentRow';
import RoseCodeAgentRow from './RoseCodeAgentRow';
import type { RoseAgentGroupsProps } from './RoseAgentGroups';
import RoseFinishedAgentsDrawer from './RoseFinishedAgentsDrawer';
import RoseTaskAgentRow from './RoseTaskAgentRow';
import { fromTreeTask } from '../background-agents/agentsPanelGroups';
import { isCodeAgentRunning } from './codeAgentRunState';

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
    progress_estimate: node.progressEstimate,
    task_progress_estimates: undefined,
    task_id: node.taskId,
    goal: node.goal,
    title: null,
    status: node.status,
    temporal_workflow_id: null,
    pinned_at: null,
    // A realtime-spawned child has no REST creation time yet; its event time is
    // the closest truth (the root's creation would sort it oldest).
    created_at: node.createdAt ?? node.updatedAt ?? root.created_at,
    last_user_message_at: node.lastUserMessageAt ?? null,
  };
}
function childStatus(agent: Agent): AgentRunStatus {
  // Tree children are spawned agents; ACTIVE is their actual workflow status.
  return agent.status === 'ACTIVE' || agent.status === 'STARTING_UP'
    ? { state: 'active', label: 'Working' }
    : agentRunStatus(agent);
}

type ChildEntry =
  | { kind: 'agent'; id: string; rank: number; at: number }
  | { kind: 'code'; code: CodeAgentListItem; rank: number; at: number };

/** One parent's children in display order: run state, then newest user message. */
function orderedChildren(
  childIds: readonly string[],
  codes: readonly CodeAgentListItem[],
  agents: ReadonlyMap<string, Agent>,
  attention: ReadonlySet<string>,
): ChildEntry[] {
  const entries: ChildEntry[] = [];
  for (const id of childIds) {
    const row = agents.get(id);
    if (!row) continue;
    const state = attention.has(id) ? 'needs-help' : childStatus(row).state;
    entries.push({
      kind: 'agent',
      id,
      rank: runStateRank(state),
      at: lastUserMessageTime(row.last_user_message_at, row.created_at),
    });
  }
  for (const code of codes) {
    entries.push({
      kind: 'code',
      code,
      rank: runStateRank(isCodeAgentRunning(code) ? 'active' : 'done'),
      at: lastUserMessageTime(null, code.created_at),
    });
  }
  return entries.sort((a, b) => a.rank - b.rank || b.at - a.at);
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
  const { agents, children, counts, codesByOwner, tasks } = useMemo(() => {
    const rootNode = tree.get(agent.agent_id);
    const progress =
      rootNode?.workflowGeneration === agent.temporal_workflow_id
        ? mergeProgressEstimate(
            agent.progress_estimate,
            rootNode?.progressEstimate,
            agent.agent_id,
            agent.status,
          )
        : agent.progress_estimate;
    const root =
      progress === agent.progress_estimate ? agent : { ...agent, progress_estimate: progress };
    const agents = new Map<string, Agent>([[agent.agent_id, root]]);
    const children = new Map<string, string[]>();
    const tasks = new Map<string, { node: TreeNode; ownerId: string; type: string }>();
    const addChild = (parent: string, child: string) => {
      const siblings = children.get(parent);
      if (siblings) siblings.push(child);
      else children.set(parent, [child]);
    };
    for (const node of tree.values()) {
      if (node.agentId !== agent.agent_id) {
        agents.set(node.agentId, childAgent(agent, node));
        if (node.parentAgentId) addChild(node.parentAgentId, node.agentId);
      }
      for (const task of node.backgroundTasks ?? []) {
        // Code tasks already have canonical provider/session rows. A task
        // represented by a real Agent node must not appear twice either.
        if (task.type === 'code' || tree.has(task.address)) continue;
        const taskNode = fromTreeTask(task, node.agentId);
        if (tasks.has(taskNode.agentId)) continue;
        tasks.set(taskNode.agentId, { node: taskNode, ownerId: node.agentId, type: task.type });
        agents.set(taskNode.agentId, childAgent(agent, taskNode));
        addChild(node.agentId, taskNode.agentId);
      }
    }
    const codeCounts = new Map<string, number>();
    const codesByOwner = new Map<string, CodeAgentListItem[]>();
    for (const code of codes) {
      const owned = codesByOwner.get(code.owner_agent_id);
      if (owned) owned.push(code);
      else codesByOwner.set(code.owner_agent_id, [code]);
      if (isCodeAgentRunning(code))
        codeCounts.set(code.owner_agent_id, (codeCounts.get(code.owner_agent_id) ?? 0) + 1);
    }
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
    return { agents, children, counts, codesByOwner, tasks };
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
    const task = tasks.get(id);
    if (task)
      return (
        <RoseTaskAgentRow
          key={id}
          node={task.node}
          type={task.type}
          ownerId={task.ownerId}
          depth={depth}
          indented={indented}
          status={childStatus(row)}
          onSelectAgent={s.onSelectAgent}
        />
      );
    const childIds = children.get(id) ?? [];
    const ownedCodes = codesByOwner.get(id) ?? [];
    const open = s.isExpanded && expanded.has(id);
    const ongoing: ChildEntry[] = [];
    const finished: ChildEntry[] = [];
    if (open) {
      for (const entry of orderedChildren(childIds, ownedCodes, agents, s.attentionAgentIds)) {
        const child = entry.kind === 'agent' ? agents.get(entry.id) : undefined;
        const status = child && childStatus(child);
        const inactive =
          entry.kind === 'code'
            ? !isCodeAgentRunning(entry.code)
            : (counts.get(entry.id) ?? 0) === 0 &&
              !s.attentionAgentIds.has(entry.id) &&
              (status?.state === 'done' || status?.reason === 'paused');
        (inactive ? finished : ongoing).push(entry);
      }
    }
    const renderEntry = (entry: ChildEntry) =>
      entry.kind === 'agent' ? (
        render(entry.id, depth + 1, new Set(path).add(id))
      ) : (
        <RoseCodeAgentRow
          key={entry.code.code_agent_id}
          codeAgent={entry.code}
          isExpanded
          parentIndented={indented}
          depth={depth + 1}
          isSelected={s.selectedCodeAgentId === entry.code.code_agent_id}
          onOpen={() => s.onOpenCodeAgent(entry.code)}
          onMenuOpenChange={s.onMenuOpenChange}
        />
      );
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
          actions={s.actionsFor(row, agent)}
          onMenuOpenChange={s.onMenuOpenChange}
          rowRef={depth === 0 ? s.observeRoot(id) : undefined}
        />
        {open && (
          <div data-testid={`rose-agent-children-${id}`}>
            {ongoing.map(renderEntry)}
            <RoseFinishedAgentsDrawer
              count={finished.length}
              depth={depth + 1}
              indented={indented}
              renderChildren={() => finished.map(renderEntry)}
            />
          </div>
        )}
      </div>
    );
  }
  return render(agent.agent_id, 0, new Set());
}
