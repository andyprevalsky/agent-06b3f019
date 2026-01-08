import { useState, useEffect, useRef } from 'react';
import { RealtimeChannel } from '@supabase/supabase-js';
import { fetchTreeState, AgentTreeNode, Agent, OutputSchema } from '@/lib/api';
import {
  subscribeToBus,
  unsubscribe,
  type AgentStateChangedPayload,
} from '@/lib/realtime';

// Re-export the type with frontend-friendly naming
export interface TreeNode {
  agentId: string;
  parentAgentId: string | null;
  goal: string;
  status: Agent['status'];
  progress: number;
  toolsInUse: string[];
  messageCount: number;
  outputSchema?: OutputSchema;
  structuredOutput?: Record<string, unknown>;
}

// Convert API response to frontend format
function apiToTreeNode(node: AgentTreeNode): TreeNode {
  return {
    agentId: node.agent_id,
    parentAgentId: node.parent_agent_id,
    goal: node.goal,
    status: node.status,
    progress: node.progress,
    toolsInUse: node.tools_in_use,
    messageCount: node.message_count,
    outputSchema: node.output_schema,
    structuredOutput: node.structured_output,
  };
}

// Singleton cache for shared bus subscriptions
const busSubscriptions = new Map<string, {
  nodes: Map<string, TreeNode>;
  listeners: Set<(nodes: Map<string, TreeNode>) => void>;
  channel: RealtimeChannel | null;
  reconnectAttempt: number;
  reconnectTimeout: number | null;
}>();

/**
 * Hook for subscribing to sub-agent tree state via Supabase bus channel.
 *
 * Uses a shared singleton so multiple SubAgentTree components using the same
 * busId share a single WebSocket subscription.
 *
 * @param busId - The shared bus channel ID (typically root agent's ID)
 * @returns Map of agent ID to TreeNode state
 */
export function useAgentTree(busId: string | null): Map<string, TreeNode> {
  const [nodes, setNodes] = useState<Map<string, TreeNode>>(new Map());
  const [forceResubscribe, setForceResubscribe] = useState(0);
  const isReconnectingRef = useRef(false);

  useEffect(() => {
    console.log(`[useAgentTree] Hook called with busId:`, busId);
    if (!busId) {
      console.log(`[useAgentTree] No busId provided, skipping subscription`);
      return;
    }

    // Get or create shared subscription
    let subscription = busSubscriptions.get(busId);
    if (!subscription) {
      subscription = {
        nodes: new Map(),
        listeners: new Set(),
        channel: null,
        reconnectAttempt: 0,
        reconnectTimeout: null,
      };
      busSubscriptions.set(busId, subscription);
    }

    // Schedule reconnect with exponential backoff
    const scheduleReconnect = () => {
      if (!busId || isReconnectingRef.current) return;

      const sub = busSubscriptions.get(busId);
      if (!sub) return;

      if (sub.reconnectTimeout) {
        clearTimeout(sub.reconnectTimeout);
      }

      const delay = Math.min(1000 * Math.pow(2, sub.reconnectAttempt), 30000);
      sub.reconnectAttempt += 1;

      console.log(`[useAgentTree] Scheduling reconnect in ${delay}ms (attempt ${sub.reconnectAttempt})`);

      sub.reconnectTimeout = window.setTimeout(() => {
        setForceResubscribe((prev) => prev + 1);
      }, delay);
    };

    // Only setup channel if we don't have one or are reconnecting
    const needsSetup = !subscription.channel || forceResubscribe > 0;

    if (needsSetup && !isReconnectingRef.current) {
      isReconnectingRef.current = true;

      // Cleanup old channel if exists
      if (subscription.channel) {
        unsubscribe(subscription.channel);
        subscription.channel = null;
      }

      // Initial fetch
      console.log(`[useAgentTree] Fetching initial tree state for busId:`, busId);
      fetchTreeState(busId)
        .then((agents) => {
          console.log(`[useAgentTree] Fetched ${agents.length} agents from /tree API`);
          const nodeMap = new Map<string, TreeNode>();
          agents.forEach((a) => nodeMap.set(a.agent_id, apiToTreeNode(a)));
          const sub = busSubscriptions.get(busId);
          if (sub) {
            sub.nodes = nodeMap;
            sub.listeners.forEach((listener) => listener(nodeMap));
          }
        })
        .catch((err) => {
          console.error('[useAgentTree] Failed to fetch initial tree state:', err);
        });

      // Subscribe to bus channel
      subscribeToBus(busId, {
        onAgentStateChanged: (data: AgentStateChangedPayload) => {
          // data is already extracted from wrapper by subscribeToBus
          console.log('[useAgentTree] Received AGENT_STATE_CHANGED:', data);
          if (!data.agentId) {
            console.warn('[useAgentTree] Missing agentId in payload');
            return;
          }

          const updatedNode: TreeNode = {
            agentId: data.agentId,
            parentAgentId: data.parentAgentId,
            goal: data.goal,
            status: data.status,
            progress: data.progress,
            toolsInUse: data.toolsInUse || [],
            messageCount: data.messageCount || 0,
            outputSchema: data.outputSchema,
            structuredOutput: data.structuredOutput,
          };

          console.log('[useAgentTree] Updating node:', updatedNode);
          const sub = busSubscriptions.get(busId);
          if (sub) {
            const newNodes = new Map(sub.nodes);
            newNodes.set(data.agentId, updatedNode);
            sub.nodes = newNodes;
            sub.listeners.forEach((listener) => listener(newNodes));
          }
        },
      })
        .then((channel) => {
          const sub = busSubscriptions.get(busId);
          if (sub) {
            sub.channel = channel;
            sub.reconnectAttempt = 0;
          }
          isReconnectingRef.current = false;
        })
        .catch((err) => {
          console.error('[useAgentTree] Failed to subscribe:', err);
          isReconnectingRef.current = false;
          scheduleReconnect();
        });
    }

    // Register this component as a listener
    const listener = (newNodes: Map<string, TreeNode>) => setNodes(new Map(newNodes));
    subscription.listeners.add(listener);

    // Initialize with current state
    setNodes(new Map(subscription.nodes));

    return () => {
      // Unregister listener
      const sub = busSubscriptions.get(busId);
      if (sub) {
        sub.listeners.delete(listener);

        // Clean up subscription if no more listeners
        if (sub.listeners.size === 0) {
          if (sub.reconnectTimeout) {
            clearTimeout(sub.reconnectTimeout);
          }
          unsubscribe(sub.channel);
          busSubscriptions.delete(busId);
        }
      }
    };
  }, [busId, forceResubscribe]);

  return nodes;
}

/**
 * Filter tree nodes to only include nodes from a specific spawn call and their descendants.
 *
 * @param allNodes - Full tree state from useAgentTree
 * @param subAgentIds - Agent IDs from this spawn call (from message metadata)
 * @returns Filtered map of nodes relevant to this spawn call
 */
export function filterTreeBySpawn(
  allNodes: Map<string, TreeNode>,
  subAgentIds: string[]
): Map<string, TreeNode> {
  const relevant = new Map<string, TreeNode>();
  const queue = [...subAgentIds];

  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = allNodes.get(id);
    if (node && !relevant.has(id)) {
      relevant.set(id, node);
      // Add children of this node
      for (const [childId, child] of allNodes) {
        if (child.parentAgentId === id && !relevant.has(childId)) {
          queue.push(childId);
        }
      }
    }
  }

  return relevant;
}

/**
 * Get circle progress state based on node state.
 *
 * States:
 * - ○ (U+25CB) - no queries yet (messageCount === 0)
 * - ◑ (U+25D1) - has queries, no progress (messageCount > 0 && progress === 0)
 * - ◔ (U+25D4) - progress < 30%
 * - ◕ (U+25D5) - progress >= 70%
 * - ● (U+25CF) - completed
 */
export function getCircleState(node: TreeNode): string {
  if (node.status === 'COMPLETED') return '●';
  if (node.progress >= 0.7) return '◕';
  if (node.progress > 0 && node.progress < 0.3) return '◔';
  if (node.messageCount > 0 && node.progress === 0) return '◑';
  return '○';
}

/**
 * Get status text for display below the goal.
 */
export function getStatusText(node: TreeNode): string {
  if (node.status === 'COMPLETED') return '';
  if (node.status === 'STARTING_UP') return 'spinning up...';
  if (node.messageCount === 0) return 'spinning up...';
  if (node.toolsInUse.length === 0) return 'thinking...';
  if (node.toolsInUse.length === 1) return node.toolsInUse[0];
  return `Using ${node.toolsInUse.length} tools`;
}
