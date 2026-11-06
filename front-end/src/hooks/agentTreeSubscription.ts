import {
  isProgressEstimateUpdate,
  isTerminalStatus,
  mergeProgressEstimate,
  mergeTaskProgressEstimates,
} from '@/lib/progressEstimate';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Agent, AgentTreeNode, OutputSchema } from '@/lib/api';
import { fetchTreeState } from '@/lib/api';
import { recordAgentScopeDiscard } from '@/lib/agentScopeDiagnostics';
import { notifyOpenAgentActivity } from '@/lib/openAgentActivity';
import {
  subscribeToBus,
  unsubscribe,
  type AgentStateChangedPayload,
  type UpdateAgentPayload,
  type FailureContext,
} from '@/lib/realtime';

export interface TreeNode {
  agentId: string;
  workflowGeneration?: string | null;
  taskProgressEstimates?: Agent['task_progress_estimates'];
  parentAgentId: string | null;
  goal: string;
  status: Agent['status'];
  progress: number;
  progressEstimate?: Agent['progress_estimate'];
  taskId?: string | null;
  toolsInUse: string[];
  messageCount: number;
  costCents: number;
  outputSchema?: OutputSchema;
  structuredOutput?: Record<string, unknown>;
  failureContext?: FailureContext;
  /** ISO creation time (REST snapshot only; realtime updates preserve it). */
  createdAt?: string;
  /** ISO last lifecycle update (REST snapshot, or the realtime event's own timestamp). */
  updatedAt?: string;
  /** ISO newest person-authored message (REST snapshot only; realtime updates preserve it). */
  lastUserMessageAt?: string;
  /** In-activity background tasks (explore/browser/code) owned by this agent. */
  backgroundTasks?: TreeBackgroundTask[];
  /** Codex-style tree address, e.g. `/root/outreach/draft_a` (absent on older rows). */
  taskPath?: string;
}

/** One background explore/browser/code task tracked on its owner agent. */
export interface TreeBackgroundTask {
  address: string;
  /** Codex-style tree path (absent on older rows). */
  path?: string;
  type: string;
  goal: string;
  status: string;
  startedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Tolerant parse of `backgroundTasks` / `background_tasks` (absent → undefined). */
export function parseBackgroundTasks(raw: unknown): TreeBackgroundTask[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tasks: TreeBackgroundTask[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.address !== 'string' || !item.address) continue;
    const startedAt = item.started_at ?? item.startedAt;
    tasks.push({
      address: item.address,
      path: typeof item.path === 'string' && item.path ? item.path : undefined,
      type: typeof item.type === 'string' ? item.type : 'agent',
      goal: typeof item.goal === 'string' ? item.goal : '',
      status: typeof item.status === 'string' ? item.status : 'running',
      startedAt: typeof startedAt === 'string' ? startedAt : undefined,
    });
  }
  return tasks;
}

/** The later of two ISO timestamps (either may be absent). */
function laterTimestamp(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

interface BusSubscription {
  nodes: Map<string, TreeNode>;
  realtimeNodes: Map<string, TreeNode>;
  pendingUpdates: Map<string, UpdateAgentPayload>;
  listeners: Set<(nodes: Map<string, TreeNode>) => void>;
  channel: RealtimeChannel | null;
  reconnectAttempt: number;
  reconnectTimeout: number | null;
  healthCheckInterval: number | null;
  connecting: boolean;
  generation: number;
}

const busSubscriptions = new Map<string, BusSubscription>();

function apiToTreeNode(node: AgentTreeNode): TreeNode {
  return {
    agentId: node.agent_id,
    workflowGeneration: node.temporal_workflow_id,
    taskProgressEstimates: mergeTaskProgressEstimates(
      undefined,
      node.task_progress_estimates ?? node.taskProgressEstimates,
    ),
    parentAgentId: node.parent_agent_id,
    goal: node.goal,
    status: node.status,
    progress: node.progress,
    progressEstimate: mergeProgressEstimate(
      undefined,
      node.progress_estimate ?? node.progressEstimate,
      node.agent_id,
      node.status,
      node.task_id,
    ),
    taskId: node.task_id,
    toolsInUse: node.tools_in_use,
    messageCount: node.message_count,
    costCents: node.tree_cost_cents,
    outputSchema: node.output_schema,
    structuredOutput: node.structured_output,
    failureContext: node.failure_context,
    createdAt: isoOrUndefined(node.created_at),
    updatedAt: isoOrUndefined(node.updated_at),
    lastUserMessageAt: isoOrUndefined(node.last_user_message_at),
    backgroundTasks: parseBackgroundTasks(node.background_tasks),
    taskPath: typeof node.task_path === 'string' && node.task_path ? node.task_path : undefined,
  };
}

function realtimeToTreeNode(data: AgentStateChangedPayload, previous?: TreeNode): TreeNode {
  return {
    agentId: data.agentId,
    parentAgentId: data.parentAgentId,
    goal: data.goal,
    status: data.status,
    progress: data.progress,
    progressEstimate: mergeProgressEstimate(
      undefined,
      data.progressEstimate,
      data.agentId,
      data.status,
      data.taskId,
    ),
    taskId: data.taskId,
    updatedAt: data.updatedAt,
    toolsInUse: data.toolsInUse || [],
    messageCount: data.messageCount || 0,
    costCents: data.costCents || 0,
    outputSchema: data.outputSchema,
    structuredOutput: data.structuredOutput,
    failureContext: data.failureContext,
    createdAt: previous?.createdAt,
    lastUserMessageAt: previous?.lastUserMessageAt,
    backgroundTasks: parseBackgroundTasks(data.backgroundTasks) ?? previous?.backgroundTasks,
    taskPath:
      typeof data.taskPath === 'string' && data.taskPath ? data.taskPath : previous?.taskPath,
  };
}

/** Apply the existing UPDATE delta without rebuilding lifecycle fields or fetching a tree. */
function withProgressUpdate(node: TreeNode, update: UpdateAgentPayload): TreeNode {
  if (
    !isProgressEstimateUpdate(update) ||
    isTerminalStatus(node.status) ||
    update.temporalWorkflowId !== node.workflowGeneration ||
    (node.updatedAt &&
      update.updatedAt &&
      Date.parse(update.updatedAt) < Date.parse(node.updatedAt))
  )
    return node;
  const progress = mergeProgressEstimate(
    node.progressEstimate,
    update.progressEstimate,
    node.agentId,
    node.status,
    node.taskId,
  );
  const tasks =
    update.taskProgressEstimates === undefined
      ? node.taskProgressEstimates
      : mergeTaskProgressEstimates(node.taskProgressEstimates, update.taskProgressEstimates);
  if (progress === node.progressEstimate && tasks === node.taskProgressEstimates) return node;
  return {
    ...node,
    progressEstimate: progress,
    taskProgressEstimates: tasks,
    updatedAt: update.updatedAt ?? node.updatedAt,
  };
}

function isLiveGeneration(
  busId: string,
  subscription: BusSubscription,
  generation: number,
): boolean {
  return (
    busSubscriptions.get(busId) === subscription &&
    subscription.listeners.size > 0 &&
    subscription.generation === generation
  );
}

function publishNodes(subscription: BusSubscription, nodes: Map<string, TreeNode>) {
  subscription.nodes = nodes;
  subscription.listeners.forEach((listener) => listener(nodes));
}

function scheduleReconnect(busId: string, subscription: BusSubscription) {
  if (
    busSubscriptions.get(busId) !== subscription ||
    subscription.listeners.size === 0 ||
    subscription.connecting ||
    subscription.reconnectTimeout !== null
  ) {
    return;
  }
  const delay = Math.min(1000 * 2 ** subscription.reconnectAttempt, 30000);
  subscription.reconnectAttempt += 1;
  subscription.reconnectTimeout = window.setTimeout(() => {
    subscription.reconnectTimeout = null;
    connectBus(busId, subscription);
  }, delay);
}

function fetchInitialTree(
  busId: string,
  subscription: BusSubscription,
  generation: number,
  reconciliationNodes: ReadonlyMap<string, TreeNode>,
) {
  void fetchTreeState(busId)
    .then((agents) => {
      if (!isLiveGeneration(busId, subscription, generation)) {
        recordAgentScopeDiscard('agent-tree-fetch', busId, null);
        return;
      }
      const nodes = new Map<string, TreeNode>();
      agents.forEach((agent) => nodes.set(agent.agent_id, apiToTreeNode(agent)));
      const reconcile = (node: TreeNode, agentId: string) => {
        const snapshot = nodes.get(agentId);
        if (
          snapshot?.workflowGeneration &&
          node.workflowGeneration &&
          snapshot.workflowGeneration !== node.workflowGeneration
        )
          return;
        // A terminal snapshot wins over a prediction event with no newer lifecycle timestamp.
        if (
          snapshot &&
          isTerminalStatus(snapshot.status) &&
          (!node.updatedAt ||
            !snapshot.updatedAt ||
            Date.parse(node.updatedAt) <= Date.parse(snapshot.updatedAt))
        )
          return;
        // Realtime values win, but only REST knows creation time / task path.
        nodes.set(agentId, {
          ...node,
          createdAt: node.createdAt ?? snapshot?.createdAt,
          // A person may have messaged from elsewhere: keep the later stamp.
          lastUserMessageAt: laterTimestamp(node.lastUserMessageAt, snapshot?.lastUserMessageAt),
          taskPath: node.taskPath ?? snapshot?.taskPath,
          backgroundTasks: node.backgroundTasks ?? snapshot?.backgroundTasks,
          progressEstimate: mergeProgressEstimate(
            snapshot?.progressEstimate,
            node.progressEstimate ?? undefined,
            agentId,
            node.status,
            node.taskId,
          ),
        });
      };
      reconciliationNodes.forEach(reconcile);
      subscription.realtimeNodes.forEach(reconcile);
      for (const [id, update] of subscription.pendingUpdates) {
        const node = nodes.get(id);
        if (node) nodes.set(id, withProgressUpdate(node, update));
      }
      subscription.pendingUpdates.clear();
      publishNodes(subscription, nodes);
    })
    .catch((error) => {
      if (isLiveGeneration(busId, subscription, generation))
        console.error('[useAgentTree] Failed to fetch initial tree state:', error);
    });
}

function createHandlers(busId: string, subscription: BusSubscription, generation: number) {
  let discardReported = false;
  const reportDiscard = () => {
    if (discardReported) return;
    discardReported = true;
    recordAgentScopeDiscard('agent-tree-event', busId, null);
  };
  return {
    onUpdate: (data: UpdateAgentPayload) => {
      if (
        !isLiveGeneration(busId, subscription, generation) ||
        !data.agentId ||
        !isProgressEstimateUpdate(data)
      )
        return;
      const previous = subscription.nodes.get(data.agentId);
      if (!previous) {
        const old = subscription.pendingUpdates.get(data.agentId);
        if (!old || old.temporalWorkflowId !== data.temporalWorkflowId) {
          if (
            !old?.updatedAt ||
            !data.updatedAt ||
            Date.parse(data.updatedAt) >= Date.parse(old.updatedAt)
          )
            subscription.pendingUpdates.set(data.agentId, data);
        } else {
          subscription.pendingUpdates.set(data.agentId, {
            ...old,
            ...data,
            progressEstimate:
              mergeProgressEstimate(
                old.progressEstimate,
                data.progressEstimate,
                data.agentId,
                'ACTIVE',
              ) ?? undefined,
            taskProgressEstimates: mergeTaskProgressEstimates(
              old.taskProgressEstimates,
              data.taskProgressEstimates,
            ),
          });
        }
        return;
      }
      const next = withProgressUpdate(previous, data);
      if (next === previous) return;
      const nodes = new Map(subscription.nodes);
      nodes.set(data.agentId, next);
      subscription.realtimeNodes.set(data.agentId, next);
      publishNodes(subscription, nodes);
    },
    onAgentStateChanged: (data: AgentStateChangedPayload) => {
      if (!isLiveGeneration(busId, subscription, generation)) {
        reportDiscard();
        return;
      }
      if (!data.agentId) {
        console.warn('[useAgentTree] Missing agentId in payload');
        return;
      }
      const nodes = new Map(subscription.nodes);
      const previous = nodes.get(data.agentId);
      if (
        previous?.updatedAt &&
        data.updatedAt &&
        Date.parse(data.updatedAt) < Date.parse(previous.updatedAt)
      )
        return;
      // Prediction-only late events must not revive a terminal child.
      if (previous && isTerminalStatus(previous.status) && data.progressEstimate && !data.updatedAt)
        return;
      const node = realtimeToTreeNode(data, subscription.nodes.get(data.agentId));
      node.workflowGeneration = data.temporalWorkflowId ?? previous?.workflowGeneration;
      node.taskProgressEstimates =
        node.workflowGeneration === previous?.workflowGeneration
          ? previous?.taskProgressEstimates
          : undefined;
      node.progressEstimate = mergeProgressEstimate(
        node.workflowGeneration === previous?.workflowGeneration
          ? previous?.progressEstimate
          : undefined,
        data.progressEstimate,
        data.agentId,
        data.status,
        data.taskId,
      );
      subscription.realtimeNodes.set(data.agentId, node);
      nodes.set(data.agentId, node);
      publishNodes(subscription, nodes);
      // This bus is held only while the open view shows the tree.
      notifyOpenAgentActivity({ agentId: data.agentId, kind: 'sub-agent' });
    },
    onDisconnect: () => {
      if (!isLiveGeneration(busId, subscription, generation)) return;
      console.warn('[useAgentTree] Channel disconnected, scheduling reconnect');
      scheduleReconnect(busId, subscription);
    },
  };
}

function connectBus(busId: string, subscription: BusSubscription) {
  if (
    busSubscriptions.get(busId) !== subscription ||
    subscription.listeners.size === 0 ||
    subscription.connecting
  ) {
    return;
  }
  subscription.connecting = true;
  subscription.generation += 1;
  // Preserve the preceding channel's realtime values only until this
  // generation's REST snapshot is reconciled. New events are tracked
  // separately so only replacement-channel data survives another reconnect.
  const reconciliationNodes = subscription.realtimeNodes;
  subscription.realtimeNodes = new Map();
  const generation = subscription.generation;
  if (subscription.channel) unsubscribe(subscription.channel);
  subscription.channel = null;
  fetchInitialTree(busId, subscription, generation, reconciliationNodes);
  void subscribeToBus(busId, createHandlers(busId, subscription, generation))
    .then((channel) => {
      if (!isLiveGeneration(busId, subscription, generation)) {
        unsubscribe(channel);
        recordAgentScopeDiscard('agent-tree-subscribe', busId, null);
        return;
      }
      subscription.channel = channel;
      subscription.reconnectAttempt = 0;
      subscription.connecting = false;
    })
    .catch((error) => {
      if (!isLiveGeneration(busId, subscription, generation)) return;
      console.error('[useAgentTree] Failed to subscribe:', error);
      subscription.connecting = false;
      scheduleReconnect(busId, subscription);
    });
}

function createSubscription(busId: string): BusSubscription {
  const subscription: BusSubscription = {
    nodes: new Map(),
    realtimeNodes: new Map(),
    pendingUpdates: new Map(),
    listeners: new Set(),
    channel: null,
    reconnectAttempt: 0,
    reconnectTimeout: null,
    healthCheckInterval: null,
    connecting: false,
    generation: 0,
  };
  subscription.healthCheckInterval = window.setInterval(() => {
    const state = subscription.channel?.state;
    if (state && state !== 'joined' && state !== 'joining') scheduleReconnect(busId, subscription);
  }, 10000);
  busSubscriptions.set(busId, subscription);
  return subscription;
}

function releaseSubscription(
  busId: string,
  subscription: BusSubscription,
  listener: (nodes: Map<string, TreeNode>) => void,
) {
  subscription.listeners.delete(listener);
  if (subscription.listeners.size > 0 || busSubscriptions.get(busId) !== subscription) return;
  busSubscriptions.delete(busId);
  subscription.generation += 1;
  if (subscription.reconnectTimeout !== null) clearTimeout(subscription.reconnectTimeout);
  if (subscription.healthCheckInterval !== null) clearInterval(subscription.healthCheckInterval);
  unsubscribe(subscription.channel);
}

/**
 * The person just messaged `agentId`: move its sidebar recency key in every
 * live tree that holds it. Only the REST snapshot carries the stamp and
 * realtime updates keep it, so without this a messaged sub-agent would not
 * reorder among its siblings until the tree resubscribed.
 */
export function noteTreeUserMessage(agentId: string, at: string): void {
  for (const subscription of busSubscriptions.values()) {
    const previous = subscription.nodes.get(agentId);
    if (!previous) continue;
    if (previous.lastUserMessageAt && Date.parse(previous.lastUserMessageAt) >= Date.parse(at))
      continue;
    const next = { ...previous, lastUserMessageAt: at };
    const nodes = new Map(subscription.nodes);
    nodes.set(agentId, next);
    if (subscription.realtimeNodes.has(agentId)) subscription.realtimeNodes.set(agentId, next);
    publishNodes(subscription, nodes);
  }
}

export function listenToAgentTree(
  busId: string,
  listener: (nodes: Map<string, TreeNode>) => void,
): () => void {
  const subscription = busSubscriptions.get(busId) ?? createSubscription(busId);
  subscription.listeners.add(listener);
  listener(subscription.nodes);
  if (!subscription.channel) connectBus(busId, subscription);
  return () => releaseSubscription(busId, subscription, listener);
}
