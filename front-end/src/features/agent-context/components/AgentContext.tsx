/**
 * STATE MACHINE: AgentContext
 *
 * Central state management for agent conversations and real-time updates.
 *
 * SUBSCRIPTION GATING:
 * canSubscribe = isAuthenticated && realtimeReady
 * - Prevents subscribing before setRealtimeAuth() has been called by useAuth
 * - realtimeReady is set true only after setRealtimeAuth completes
 *
 * AGENT SELECTION (agentId filtering pattern):
 * +-------------------------------------------------------------------------+
 * | SWITCH FROM AGENT A -> AGENT B:                                        |
 * |                                                                         |
 * | 1. KILL CONNECTIONS --> unsubscribe(channel), clear timeouts           |
 * |                                                                         |
 * | 2. FLUSH STATE -------> setMessages([]), clear streaming state         |
 * |                                                                         |
 * | 3. CONNECT NEW -------> subscribeToAgent(newAgentId)                   |
 * |                          loadAgentDetail(newAgentId)                    |
 * |                                                                         |
 * | Message filtering: Each payload includes agentId, handlers check       |
 * | data.agentId === selectedAgentId to prevent cross-agent contamination. |
 * | Messages from wrong agent are simply discarded.                        |
 * |                                                                         |
 * | Race prevention: loadAgentDetail merges API messages with any          |
 * | realtime messages that arrived, using message_id for deduplication.    |
 * +-------------------------------------------------------------------------+
 *
 * AGENT SELECTION STATES:
 * [NO_AGENT] <-- selectedAgentId: null, gate: open, URL: no agent-id param
 *     |
 *     v (setSelectedAgentId) -> SYNC URL -> CLOSE GATE -> KILL -> FLUSH
 * [LOADING_AGENT] <-- fetch agent detail + subscribe, gate: closed, URL: ?agent-id=X
 *     |
 *     v (benchmark dev preview without auth) -> fetch retained run only, skip realtime
 *     |
 *     v (subscription + fetch complete) -> OPEN GATE
 * [AGENT_ACTIVE] <-- agentDetail: AgentDetail, messages: Message[], gate: open, URL: ?agent-id=X
 *     |
 *     | (change agent) -> SYNC URL -> CLOSE GATE first, prevents cross-agent contamination
 *     v
 * [NO_AGENT] or [LOADING_AGENT]
 *
 * URL SYNC (bidirectional):
 * - On mount: URL ?agent-id=X -> selectedAgentId = X
 * - On setSelectedAgentId(X): selectedAgentId = X -> URL ?agent-id=X
 * - On setSelectedAgentId(null): selectedAgentId = null -> URL removes agent-id param
 * - On popstate (back/forward): URL ?agent-id=X -> selectedAgentId = X (syncs URL -> state)
 * - Refresh preserves agent selection via URL
 *
 * REALTIME STREAMING:
 * [IDLE] --> subscribed to Supabase realtime channel
 *     |
 *     v (stream event with matching agentId)
 * [STREAMING] --> updates streamingBubbles, streamingPlans, streamingAttention, streamingTools
 *     |
 *     v (stream complete)
 * [IDLE] --> content moved to messages array
 *
 * MESSAGE SENDING:
 * [IDLE] <-- isSending: false
 *     |
 *     v (postMessage)
 * [SENDING] <-- isSending: true
 *     |
 *     v (complete)
 * [IDLE]
 *
 * Key state:
 * - selectedAgentId: string | null
 * - agentDetail: AgentDetail | null
 * - messages: Message[]
 * - streamingBubbles: Map<string, StreamingBubble>
 * - streamingPlans, streamingAttention, streamingTools: Maps
 * - isSending: boolean
 */

import type { AgentProviderProps } from '../types';
import { AgentContext, useAgentProvider } from '../hooks';

export { AgentContext };

export function AgentProvider({ children, ...rest }: AgentProviderProps) {
  const value = useAgentProvider(rest);
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export default AgentContext;
