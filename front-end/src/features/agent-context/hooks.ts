import { useState, useRef, useCallback, useEffect, useContext, createContext } from 'react';
import { type RealtimeChannel } from '@supabase/supabase-js';
import { unsubscribe } from '@/lib/realtime';
import { getQueryParams } from '@/lib/url';
import type { AgentDetail, Message } from '@/lib/api';
import { isBenchmarkArchiveMode } from '@/lib/benchmarkArchive';

import type {
  StreamingBubble,
  StreamingPlan,
  StreamingAttention,
  StreamingTool,
  MessageHandler,
  AgentContextValue,
  AgentProviderProps,
} from './types';
import { benchmarkAgentPreviewEnabled, fetchAgentDetail, postAgentMessage } from './api';
import { useRealtimeSubscription } from './hooks/useRealtimeSubscription';
import { useVisibilityReconnect } from './hooks/useVisibilityReconnect';
import { useHealthCheck } from './hooks/useHealthCheck';
import { usePopstateSync } from './hooks/usePopstateSync';

// ─── Context object ─────────────────────────────────────────────────────────

export const AgentContext = createContext<AgentContextValue | null>(null);

// ─── Consumer hook ──────────────────────────────────────────────────────────

export function useAgentContext(): AgentContextValue {
  const context = useContext(AgentContext);
  if (!context) {
    throw new Error('useAgentContext must be used within AgentProvider');
  }
  return context;
}

// ─── Provider hook ──────────────────────────────────────────────────────────

type ProviderDeps = Pick<
  AgentProviderProps,
  'user' | 'isAuthenticated' | 'realtimeReady' | 'onLoadAgents'
>;

/** Core state + logic powering AgentProvider. Keeps the component thin. */
// eslint-disable-next-line max-lines-per-function
export function useAgentProvider({
  user,
  isAuthenticated,
  realtimeReady,
  onLoadAgents,
}: ProviderDeps) {
  const archiveMode = isBenchmarkArchiveMode();
  // canSubscribe requires both authentication AND realtime auth to be set
  const canSubscribe = (isAuthenticated ?? !!user) && (realtimeReady ?? false);
  // Direct ?agent-id= links can load via realtime auth, the benchmark archive
  // viewer, or the dev/benchmark preview endpoint.
  const canLoadAgent = canSubscribe || archiveMode || benchmarkAgentPreviewEnabled();

  // ─── Agent state ─────────────────────────────────────────────────────────
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [selectedAgentId, setSelectedAgentIdState] = useState<string | null>(() => {
    return getQueryParams().get('agent-id');
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingAgent, setIsLoadingAgent] = useState(false);

  // ─── Streaming state ────────────────────────────────────────────────────
  const [streamingBubbles, setStreamingBubbles] = useState<Map<string, StreamingBubble>>(new Map());
  const [streamingPlan, setStreamingPlan] = useState<StreamingPlan | null>(null);
  const [streamingAttention, setStreamingAttention] = useState<StreamingAttention | null>(null);
  const [streamingTools, setStreamingTools] = useState<Map<string, StreamingTool>>(new Map());
  const [isChatMode, setIsChatMode] = useState(true);

  // ─── Realtime refs ──────────────────────────────────────────────────────
  const channelRef = useRef<RealtimeChannel | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const isReconnectingRef = useRef<boolean>(false);
  const [forceResubscribeCounter, setForceResubscribeCounter] = useState(0);
  const initialLoadDoneRef = useRef<string | null>(null);
  const messageHandlersRef = useRef<Map<string | null, MessageHandler>>(new Map());
  const streamedTextsRef = useRef<Set<string>>(new Set());
  const completedStreamIdsRef = useRef<Set<string>>(new Set());

  // ─── Message handler registration ───────────────────────────────────────

  const registerMessageHandler = useCallback(
    (subAgentId: string | null, handler: MessageHandler): (() => void) => {
      messageHandlersRef.current.set(subAgentId, handler);
      return () => {
        messageHandlersRef.current.delete(subAgentId);
      };
    },
    [],
  );

  // ─── Dispatch message to appropriate handler ────────────────────────────

  const dispatchMessage = useCallback((message: Message) => {
    const targetSubAgentId = message.metadata?.subAgentId ?? null;
    const handler = messageHandlersRef.current.get(targetSubAgentId);

    if (handler) {
      handler(message);
    } else if (targetSubAgentId !== null) {
      const mainHandler = messageHandlersRef.current.get(null);
      if (mainHandler) {
        mainHandler(message);
      }
    }
  }, []);

  // ─── Load agent ─────────────────────────────────────────────────────────

  const loadAgentDetail = useCallback(async (agentId: string) => {
    try {
      setIsLoadingAgent(true);
      const data = await fetchAgentDetail(agentId);
      setAgent(data.agent);
      setMessages((prev) => {
        const apiIds = new Set(data.messages.map((m) => m.message_id));
        const realtimeOnly = prev.filter((m) => !apiIds.has(m.message_id));
        return [...data.messages, ...realtimeOnly];
      });
      setIsChatMode(!data.agent.temporal_workflow_id);
      initialLoadDoneRef.current = agentId;
    } catch (error) {
      console.error('Failed to load agent:', error);
      setSelectedAgentIdState(null);
      const url = new URL(window.location.href);
      url.searchParams.delete('agent-id');
      window.history.replaceState({}, '', url.toString());
    } finally {
      setIsLoadingAgent(false);
    }
  }, []);

  // ─── Load agent from URL on mount ───────────────────────────────────────

  useEffect(() => {
    if (selectedAgentId && canLoadAgent && !agent) {
      void loadAgentDetail(selectedAgentId);
    }
  }, [canLoadAgent, selectedAgentId, agent, loadAgentDetail]);

  // ─── Set selected agent (with load) ─────────────────────────────────────

  const setSelectedAgentId = useCallback(
    (id: string | null) => {
      syncUrlParam(id);
      killConnections(channelRef, reconnectTimeoutRef, isReconnectingRef);
      flushState(
        setMessages,
        setStreamingBubbles,
        setStreamingPlan,
        setStreamingAttention,
        setStreamingTools,
        setAgent,
        streamedTextsRef,
        completedStreamIdsRef,
        initialLoadDoneRef,
        setIsChatMode,
      );
      setSelectedAgentIdState(id);
      // Same access gate as the URL-on-mount load: when access isn't ready
      // yet, the effect above loads the id once canLoadAgent flips true
      // (agent is null after flushState, so it fires).
      if (id && canLoadAgent) {
        void loadAgentDetail(id);
      }
    },
    [canLoadAgent, loadAgentDetail],
  );

  // ─── Send message ───────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (text: string) => {
      if (!selectedAgentId) {
        throw new Error('No agent selected');
      }
      await postAgentMessage(selectedAgentId, text);
    },
    [selectedAgentId],
  );

  // ─── Force resubscribe ──────────────────────────────────────────────────

  const forceResubscribe = useCallback(() => {
    setForceResubscribeCounter((prev) => prev + 1);
  }, []);

  // ─── Realtime subscription ──────────────────────────────────────────────

  useRealtimeSubscription({
    selectedAgentId,
    canSubscribe,
    forceResubscribeCounter,
    channelRef,
    reconnectAttemptRef,
    reconnectTimeoutRef,
    isReconnectingRef,
    initialLoadDoneRef,
    streamedTextsRef,
    completedStreamIdsRef,
    setStreamingBubbles,
    setStreamingPlan,
    setStreamingAttention,
    setStreamingTools,
    setMessages,
    setAgent,
    setIsChatMode,
    setForceResubscribeCounter,
    dispatchMessage,
    onLoadAgents,
  });

  // ─── Tab visibility reconnect ─────────────────────────────────────────

  useVisibilityReconnect(selectedAgentId, channelRef, setForceResubscribeCounter);

  // ─── Periodic health check ────────────────────────────────────────────

  useHealthCheck(
    selectedAgentId,
    canSubscribe,
    channelRef,
    isReconnectingRef,
    setForceResubscribeCounter,
  );

  // ─── URL popstate sync ────────────────────────────────────────────────

  usePopstateSync(selectedAgentId, setSelectedAgentId);

  // ─── Clear streaming on pause ─────────────────────────────────────────

  useEffect(() => {
    if (agent?.status === 'PAUSED') {
      setStreamingBubbles(new Map());
      setStreamingPlan(null);
      setStreamingTools(new Map());
    }
  }, [agent?.status]);

  return {
    agent,
    setAgent,
    selectedAgentId,
    setSelectedAgentId,
    messages,
    setMessages,
    streamingBubbles,
    streamingPlan,
    streamingAttention,
    streamingTools,
    streamedTextsRef,
    registerMessageHandler,
    sendMessage,
    isLoadingAgent,
    forceResubscribe,
    isChatMode,
  } satisfies AgentContextValue;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers (extracted from setSelectedAgentId for readability)
// ═══════════════════════════════════════════════════════════════════════════════

function syncUrlParam(id: string | null) {
  const url = new URL(window.location.href);
  const previousAgentId = url.searchParams.get('agent-id');
  if (id) {
    url.searchParams.set('agent-id', id);
    if (previousAgentId && previousAgentId !== id) {
      url.searchParams.delete('browser-id');
    }
  } else {
    url.searchParams.delete('agent-id');
    url.searchParams.delete('browser-id');
  }
  window.history.replaceState({}, '', url.toString());
}

function killConnections(
  channelRef: React.MutableRefObject<RealtimeChannel | null>,
  reconnectTimeoutRef: React.MutableRefObject<number | null>,
  isReconnectingRef: React.MutableRefObject<boolean>,
) {
  if (channelRef.current) {
    unsubscribe(channelRef.current);
    channelRef.current = null;
  }
  if (reconnectTimeoutRef.current) {
    clearTimeout(reconnectTimeoutRef.current);
    reconnectTimeoutRef.current = null;
  }
  isReconnectingRef.current = false;
}

function flushState(
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  setStreamingBubbles: React.Dispatch<React.SetStateAction<Map<string, StreamingBubble>>>,
  setStreamingPlan: React.Dispatch<React.SetStateAction<StreamingPlan | null>>,
  setStreamingAttention: React.Dispatch<React.SetStateAction<StreamingAttention | null>>,
  setStreamingTools: React.Dispatch<React.SetStateAction<Map<string, StreamingTool>>>,
  setAgent: React.Dispatch<React.SetStateAction<AgentDetail | null>>,
  streamedTextsRef: React.MutableRefObject<Set<string>>,
  completedStreamIdsRef: React.MutableRefObject<Set<string>>,
  initialLoadDoneRef: React.MutableRefObject<string | null>,
  setIsChatMode: React.Dispatch<React.SetStateAction<boolean>>,
) {
  setMessages([]);
  setStreamingBubbles((prev) => {
    for (const [, bubble] of prev) {
      if (bubble.timeoutId) window.clearTimeout(bubble.timeoutId);
    }
    return new Map();
  });
  setStreamingPlan(null);
  setStreamingAttention(null);
  setStreamingTools(new Map());
  setAgent(null);
  streamedTextsRef.current.clear();
  completedStreamIdsRef.current.clear();
  initialLoadDoneRef.current = null;
  setIsChatMode(true);
}
