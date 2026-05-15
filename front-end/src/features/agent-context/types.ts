import type React from 'react';
import type { AgentDetail, Message } from '@/lib/api';

export interface StreamingBubble {
  text: string;
  sequence: number;
  done: boolean;
  timeoutId?: number;
  subAgentId?: string;
  startedAtMs?: number;
  /** True when the streaming model is Claude (Anthropic) */
  isClaude?: boolean;
  /** True when the streaming model is direct GPT/Codex */
  isGpt?: boolean;
  /** LLM request start timestamp from the stream producer */
  llmStartedAtMs?: number;
}

export interface StreamingPlan {
  stream_id: string;
  tool_call_id: string;
  title: string;
  char_count?: number;
  startedAtMs?: number;
  subAgentId?: string;
}

export interface StreamingAttention {
  stream_id: string;
  tool_call_id: string;
  message: string;
  is_question: boolean;
  subAgentId?: string;
}

export interface StreamingTool {
  stream_id: string;
  tool_call_id: string;
  tool_name: string;
  title: string;
  charCount?: number;
  subAgentId?: string;
  startedAtMs?: number;
  /** True when the streaming model is Claude (Anthropic) */
  isClaude?: boolean;
  /** True when the streaming model is direct GPT/Codex */
  isGpt?: boolean;
}

export type MessageHandler = (message: Message) => void;

export interface AgentContextValue {
  // Agent data
  agent: AgentDetail | null;
  setAgent: React.Dispatch<React.SetStateAction<AgentDetail | null>>;
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;

  // Messages (history, not buffer - buffer is in MessageList)
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;

  // Streaming state (shared across MessageLists, each filters by subAgentId)
  streamingBubbles: Map<string, StreamingBubble>;
  streamingPlan: StreamingPlan | null;
  streamingAttention: StreamingAttention | null;
  streamingTools: Map<string, StreamingTool>; // tool_call_id -> streaming tool

  // Streamed texts - used by MessageList to skip animation for already-streamed content
  streamedTextsRef: React.MutableRefObject<Set<string>>;

  // Message routing - MessageList instances register handlers
  registerMessageHandler: (subAgentId: string | null, handler: MessageHandler) => () => void;

  // Actions
  sendMessage: (text: string) => Promise<void>;

  // Loading state
  isLoadingAgent: boolean;

  // Force resubscribe trigger
  forceResubscribe: () => void;

  // Chat mode state - true when agent has no Temporal workflow (chat mode), false when in agent mode
  isChatMode: boolean;
}

export interface AgentProviderProps {
  children: React.ReactNode;
  /** Auth user (null for anonymous users in some contexts) */
  user: unknown;
  /** True for both JWT and anonymous users (Supabase native) */
  isAuthenticated?: boolean;
  /** True when realtime auth has been set */
  realtimeReady?: boolean;
  /** Callback to refresh agent list in sidebar */
  onLoadAgents?: () => void;
}
