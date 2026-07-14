import { useRef, useState } from 'react';
import { type RealtimeChannel } from '@supabase/supabase-js';

import { getQueryParams } from '@/lib/url';
import type { AgentDetail, Message } from '@/lib/api';

import type {
  MessageHandler,
  PendingAgentCreation,
  StreamingAttention,
  StreamingBubble,
  StreamingPlan,
  StreamingTool,
} from '../types';

export function useAgentProviderState() {
  const initialAgentId = getQueryParams().get('agent-id');
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [selectedAgentId, setSelectedAgentIdState] = useState<string | null>(initialAgentId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingAgent, setIsLoadingAgent] = useState(false);
  const [streamingBubbles, setStreamingBubbles] = useState<Map<string, StreamingBubble>>(new Map());
  const [streamingPlan, setStreamingPlan] = useState<StreamingPlan | null>(null);
  const [streamingAttention, setStreamingAttention] = useState<StreamingAttention | null>(null);
  const [streamingTools, setStreamingTools] = useState<Map<string, StreamingTool>>(new Map());
  const [isChatMode, setIsChatMode] = useState(true);
  const [forceResubscribeCounter, setForceResubscribeCounter] = useState(0);

  return {
    agent,
    setAgent,
    selectedAgentId,
    setSelectedAgentIdState,
    selectedAgentIdRef: useRef<string | null>(initialAgentId),
    pendingCreationRef: useRef<PendingAgentCreation | null>(null),
    messages,
    setMessages,
    isLoadingAgent,
    setIsLoadingAgent,
    streamingBubbles,
    setStreamingBubbles,
    streamingPlan,
    setStreamingPlan,
    streamingAttention,
    setStreamingAttention,
    streamingTools,
    setStreamingTools,
    isChatMode,
    setIsChatMode,
    forceResubscribeCounter,
    setForceResubscribeCounter,
    channelRef: useRef<RealtimeChannel | null>(null),
    reconnectAttemptRef: useRef(0),
    reconnectTimeoutRef: useRef<number | null>(null),
    isReconnectingRef: useRef(false),
    initialLoadDoneRef: useRef<string | null>(null),
    messageHandlersRef: useRef<Map<string | null, MessageHandler>>(new Map()),
    streamedTextsRef: useRef<Set<string>>(new Set()),
    completedStreamIdsRef: useRef<Set<string>>(new Set()),
  };
}

export type AgentProviderState = ReturnType<typeof useAgentProviderState>;
