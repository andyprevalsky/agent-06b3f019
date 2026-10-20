import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Agent, AgentTreeNode, OutputSchema } from '@/lib/api';
import { fetchTreeState } from '@/lib/api';
import { recordAgentScopeDiscard } from '@/lib/agentScopeDiagnostics';
import { notifyOpenAgentActivity } from '@/lib/openAgentActivity';
import {
  subscribeToBus,
  unsubscribe,
  type AgentStateChangedPayload,
  type FailureContext,
} from '@/lib/realtime';

export interface TreeNode {
  agentId: string;
  parentAgentId: string | null;
  goal: string;
  status: Agent['status'];
  progress: number;
  toolsInUse: string[];
  messageCount: number;
  costCents: number;
  outputSchema?: OutputSchema;
  structuredOutput?: Record<string, unknown>;
  failureContext?: FailureContext;
}

interface BusSubscription {
  nodes: Map<string, TreeNode>;
  realtimeNodes: Map<string, TreeNode>;
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
    parentAgentId: node.parent_agent_id,
    goal: node.goal,
    status: node.status,
    progress: node.progress,
    toolsInUse: node.tools_in_use,
    messageCount: node.message_count,
    costCents: node.tree_cost_cents,
    outputSchema: node.output_schema,
    structuredOutput: node.structured_output,
    failureContext: node.failure_context,
  };
}

function realtimeToTreeNode(data: AgentStateChangedPayload): TreeNode {
  return {
    agentId: data.agentId,
    parentAgentId: data.parentAgentId,
    goal: data.goal,
    status: data.status,
    progress: data.progress,
    toolsInUse: data.toolsInUse || [],
    messageCount: data.messageCount || 0,
    costCents: data.costCents || 0,
    outputSchema: data.outputSchema,
    structuredOutput: data.structuredOutput,
    failureContext: data.failureContext,
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
      reconciliationNodes.forEach((node, agentId) => nodes.set(agentId, node));
      subscription.realtimeNodes.forEach((node, agentId) => nodes.set(agentId, node));
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
      const node = realtimeToTreeNode(data);
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
