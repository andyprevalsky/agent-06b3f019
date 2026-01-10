/**
 * STATE MACHINE: AgentContext
 *
 * Central state management for agent conversations and real-time updates.
 *
 * AGENT SELECTION:
 * [NO_AGENT] <-- selectedAgentId: null
 *     |
 *     v (setSelectedAgentId)
 * [LOADING_AGENT] <-- fetch agent detail + subscribe to realtime
 *     |
 *     v (fetch complete)
 * [AGENT_ACTIVE] <-- agentDetail: AgentDetail, messages: Message[]
 *     |
 *     | (change agent)
 *     v
 * [NO_AGENT] or [LOADING_AGENT]
 *
 * REALTIME STREAMING:
 * [IDLE] --> subscribed to Supabase realtime channel
 *     |
 *     v (stream event)
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

import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { RealtimeChannel } from '@supabase/supabase-js';
import {
  subscribeToAgent,
  unsubscribe,
  // Typed payloads from realtime-types.ts
  type AssistantStreamPayload,
  type PlanStreamPayload,
  type AttentionStreamPayload,
  type ToolStreamPayload,
  type InsertMessagePayload,
  type UpdateAgentPayload,
} from '@/lib/realtime';
import {
  getAgent,
  postMessage as postMessageAPI,
  AgentDetail,
  Message
} from '@/lib/api';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface StreamingBubble {
  text: string;
  sequence: number;
  done: boolean;
  timeoutId?: number;
  subAgentId?: string;
}

export interface StreamingPlan {
  stream_id: string;
  tool_call_id: string;
  title: string;
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
  subAgentId?: string;
}

type MessageHandler = (message: Message) => void;

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
  streamingTools: Map<string, StreamingTool>;  // tool_call_id -> streaming tool

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

const AgentContext = createContext<AgentContextValue | null>(null);

// ═══════════════════════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════════════════════

interface AgentProviderProps {
  children: React.ReactNode;
  user: any; // Auth user (null for anonymous users in some contexts)
  isAuthenticated?: boolean; // True for both JWT and anonymous users (Supabase native)
  onLoadAgents?: () => void; // Callback to refresh agent list in sidebar
}

export function AgentProvider({ children, user, isAuthenticated, onLoadAgents }: AgentProviderProps) {
  // canSubscribe is true when user is authenticated (JWT or anonymous - both have real Supabase sessions)
  const canSubscribe = isAuthenticated ?? !!user;
  // Agent state
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [selectedAgentId, setSelectedAgentIdState] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingAgent, setIsLoadingAgent] = useState(false);
  
  // Streaming state
  const [streamingBubbles, setStreamingBubbles] = useState<Map<string, StreamingBubble>>(new Map());
  const [streamingPlan, setStreamingPlan] = useState<StreamingPlan | null>(null);
  const [streamingAttention, setStreamingAttention] = useState<StreamingAttention | null>(null);
  const [streamingTools, setStreamingTools] = useState<Map<string, StreamingTool>>(new Map());

  // Chat mode state - derived from agent.temporal_workflow_id being null
  const [isChatMode, setIsChatMode] = useState(true);
  
  // Realtime refs
  const channelRef = useRef<RealtimeChannel | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const isReconnectingRef = useRef<boolean>(false);
  const [forceResubscribeCounter, setForceResubscribeCounter] = useState(0);
  
  // Track if initial load has happened to avoid double-fetch
  const initialLoadDoneRef = useRef<string | null>(null);
  
  // Message handlers map - MessageList instances register here
  const messageHandlersRef = useRef<Map<string | null, MessageHandler>>(new Map());
  
  // Track streamed texts to skip re-animation on INSERT
  const streamedTextsRef = useRef<Set<string>>(new Set());
  
  const STREAM_TIMEOUT_MS = 15000;

  // ═══════════════════════════════════════════════════════════════════════════
  // Message Handler Registration
  // ═══════════════════════════════════════════════════════════════════════════
  
  const registerMessageHandler = useCallback((
    subAgentId: string | null, 
    handler: MessageHandler
  ): (() => void) => {
    messageHandlersRef.current.set(subAgentId, handler);
    return () => {
      messageHandlersRef.current.delete(subAgentId);
    };
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // Dispatch message to appropriate handler
  // ═══════════════════════════════════════════════════════════════════════════
  
  const dispatchMessage = useCallback((message: Message) => {
    const targetSubAgentId = message.metadata?.subAgentId ?? null;
    const handler = messageHandlersRef.current.get(targetSubAgentId);
    
    if (handler) {
      handler(message);
    } else if (targetSubAgentId !== null) {
      // Sub-agent message but no handler registered - fallback to main chat
      const mainHandler = messageHandlersRef.current.get(null);
      if (mainHandler) {
        mainHandler(message);
      }
    }
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // Load Agent
  // ═══════════════════════════════════════════════════════════════════════════
  
  const loadAgentDetail = useCallback(async (agentId: string) => {
    try {
      setIsLoadingAgent(true);
      const data = await getAgent(agentId);
      setAgent(data.agent);
      setMessages(data.messages);
      // Set chat mode based on whether agent has a Temporal workflow
      setIsChatMode(!data.agent.temporal_workflow_id);
      // Mark initial load as done for this agent to avoid double-fetch in subscription setup
      initialLoadDoneRef.current = agentId;
    } catch (error) {
      console.error('Failed to load agent:', error);
    } finally {
      setIsLoadingAgent(false);
    }
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // Set Selected Agent (with load)
  // ═══════════════════════════════════════════════════════════════════════════
  
  const setSelectedAgentId = useCallback((id: string | null) => {
    setSelectedAgentIdState(id);
    
    if (id) {
      loadAgentDetail(id);
    } else {
      // Clear state when deselecting
      setAgent(null);
      setMessages([]);
      setStreamingBubbles(new Map());
      setStreamingPlan(null);
      setStreamingAttention(null);
      setIsChatMode(true); // Reset to chat mode default
      // Reset initial load tracking
      initialLoadDoneRef.current = null;
    }
  }, [loadAgentDetail]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Send Message
  // ═══════════════════════════════════════════════════════════════════════════
  
  const sendMessage = useCallback(async (text: string) => {
    if (!selectedAgentId) {
      throw new Error('No agent selected');
    }
    await postMessageAPI(selectedAgentId, text);
  }, [selectedAgentId]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Force Resubscribe
  // ═══════════════════════════════════════════════════════════════════════════
  
  const forceResubscribe = useCallback(() => {
    setForceResubscribeCounter(prev => prev + 1);
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // Realtime Subscription
  // ═══════════════════════════════════════════════════════════════════════════
  
  useEffect(() => {
    // Cleanup function
    const cleanup = () => {
      console.log('🧹 AgentContext: cleanup running');
      isReconnectingRef.current = false;
      
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      
      if (channelRef.current) {
        unsubscribe(channelRef.current);
        channelRef.current = null;
      }
      
      // Clear streaming bubbles and their timeouts
      setStreamingBubbles(prev => {
        for (const [_, bubble] of prev) {
          if (bubble.timeoutId) {
            window.clearTimeout(bubble.timeoutId);
          }
        }
        return new Map();
      });
      
      setStreamingPlan(null);
      setStreamingAttention(null);
    };

    if (!selectedAgentId || !canSubscribe) {
      cleanup();
      return cleanup;
    }

    if (isReconnectingRef.current) {
      console.log('⏳ AgentContext: Reconnection already in progress');
      return cleanup;
    }

    isReconnectingRef.current = true;

    if (channelRef.current) {
      channelRef.current.unsubscribe();
      channelRef.current = null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const scheduleReconnect = () => {
      if (!selectedAgentId || !canSubscribe) return;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      reconnectAttemptRef.current += 1;

      reconnectTimeoutRef.current = window.setTimeout(() => {
        setForceResubscribeCounter(prev => prev + 1);
      }, delay);
    };

    const setupRealtime = async () => {
      try {
        const channel = await subscribeToAgent(selectedAgentId, {
          onInsert: (data: InsertMessagePayload) => {
            // data is already extracted from wrapper by subscribeToAgent
            const message: Message = {
              message_id: data.id,
              timestamp: data.timestamp,
              text: data.text,
              role: data.role,
              metadata: data.metadata ?? undefined,
            };
            
            console.log(`📥 AgentContext INSERT:`, {
              role: message.role,
              message_id: message.message_id,
              subAgentId: message.metadata?.subAgentId,
            });
            
            // Clear streaming bubbles on ASSISTANT INSERT
            // Both main agent and browser agent now send thinking as ASSISTANT messages
            if (message.role === 'ASSISTANT') {
              const subAgentId = message.metadata?.subAgentId ?? null;
              setStreamingBubbles(prev => {
                const newMap = new Map(prev);
                // Clear bubbles for this subAgentId (or all if null)
                for (const [streamId, bubble] of newMap) {
                  if ((bubble.subAgentId ?? null) === subAgentId) {
                    if (bubble.timeoutId) {
                      window.clearTimeout(bubble.timeoutId);
                    }
                    newMap.delete(streamId);
                  }
                }
                return newMap;
              });
            }
            
            // Clear streaming plan on set_plan FINISHED
            if (message.role === 'TOOL' && 
                message.metadata?.toolName === 'set_plan' && 
                message.metadata?.toolStatus === 'FINISHED') {
              setStreamingPlan(null);
            }
            
            // Clear streaming attention on send_message_to_user
            if (message.role === 'TOOL' && 
                message.metadata?.toolName === 'send_message_to_user') {
              setStreamingAttention(null);
            }
            
            // Clear streaming tool when real TOOL message arrives with same toolCallId
            if (message.role === 'TOOL' && message.metadata?.toolCallId) {
              setStreamingTools(prev => {
                if (prev.has(message.metadata!.toolCallId)) {
                  const newMap = new Map(prev);
                  newMap.delete(message.metadata!.toolCallId);
                  return newMap;
                }
                return prev;
              });
            }
            
            // Add to messages history
            setMessages(prev => [...prev, message]);
            
            // Dispatch to appropriate MessageList handler
            dispatchMessage(message);
          },
          
          onUpdate: (updated: UpdateAgentPayload) => {
            // updated is already extracted from wrapper by subscribeToAgent
            setAgent(prev => {
              if (!prev) return prev;
              return {
                ...prev,
                progress: updated.progress ?? prev.progress,
                status: updated.status ?? prev.status,
                status_message: updated.statusMessage ?? prev.status_message,
                model: updated.model ?? prev.model,
                token_count: updated.tokenCount ?? prev.token_count,
                tokens_in: updated.tokensIn ?? prev.tokens_in,
                tokens_out: updated.tokensOut ?? prev.tokens_out,
                context_size: updated.contextSize ?? prev.context_size,
                message_count: updated.messageCount ?? prev.message_count,
                updated_at: updated.updatedAt ?? prev.updated_at,
              };
            });

            onLoadAgents?.();
          },
          
          onAssistantStream: (chunk: AssistantStreamPayload) => {
            console.log(`📡 AgentContext STREAM:`, {
              stream_id: chunk.stream_id,
              sequence: chunk.sequence,
              done: chunk.done,
            });
            
            setStreamingBubbles(prev => {
              const newMap = new Map(prev);
              const existing = newMap.get(chunk.stream_id);
              
              if (!existing || chunk.sequence >= existing.sequence) {
                if (existing?.timeoutId) {
                  window.clearTimeout(existing.timeoutId);
                }
                
                const accumulatedText = (existing?.text || '') + chunk.delta;
                
                let timeoutId: number | undefined;
                if (chunk.done) {
                  if (accumulatedText.trim()) {
                    streamedTextsRef.current.add(accumulatedText.trim());
                  }
                  
                  timeoutId = window.setTimeout(() => {
                    console.warn(`Stream ${chunk.stream_id} timeout`);
                    setStreamingBubbles(p => {
                      const m = new Map(p);
                      m.delete(chunk.stream_id);
                      return m;
                    });
                  }, STREAM_TIMEOUT_MS);
                }
                
                newMap.set(chunk.stream_id, {
                  text: accumulatedText,
                  sequence: chunk.sequence,
                  done: chunk.done,
                  timeoutId,
                  // Extract subAgentId from payload (for browser agent routing)
                  subAgentId: chunk.subAgentId ?? existing?.subAgentId,
                });
              }
              
              return newMap;
            });
          },
          
          onPlanStream: (plan: PlanStreamPayload) => {
            console.log(`📋 AgentContext PLAN STREAM:`, plan);
            setStreamingPlan({
              stream_id: plan.stream_id,
              tool_call_id: plan.tool_call_id,
              title: plan.title,
            });
          },
          
          onAttentionStream: (attention: AttentionStreamPayload) => {
            console.log(`📢 AgentContext ATTENTION STREAM:`, attention);
            setStreamingAttention({
              stream_id: attention.stream_id,
              tool_call_id: attention.tool_call_id,
              message: attention.message,
              is_question: false,
            });
          },
          
          onToolStream: (tool: ToolStreamPayload) => {
            console.log(`🔧 AgentContext TOOL STREAM:`, tool);
            setStreamingTools(prev => {
              const newMap = new Map(prev);
              newMap.set(tool.tool_call_id, {
                stream_id: tool.stream_id,
                tool_call_id: tool.tool_call_id,
                tool_name: tool.tool_name,
                title: tool.title,
              });
              return newMap;
            });
          },

          onAgentModeStarted: () => {
            console.log(`🚀 AgentContext AGENT_MODE_STARTED`);
            setIsChatMode(false);
          },
        });

        channelRef.current = channel;
        reconnectAttemptRef.current = 0;
        isReconnectingRef.current = false;
        
        // Only refetch if this is a reconnection (e.g., tab visibility change), not initial load
        // Initial load is handled by loadAgentDetail to avoid double-fetch which breaks opacity transition
        const isReconnection = initialLoadDoneRef.current === selectedAgentId;
        if (isReconnection && forceResubscribeCounter > 0) {
          try {
            const data = await getAgent(selectedAgentId);
            setMessages(data.messages);
            setAgent(data.agent);
          } catch (error) {
            console.error('Failed to refetch after reconnection:', error);
          }
        }
      } catch (error) {
        console.error('Failed to subscribe:', error);
        isReconnectingRef.current = false;
        scheduleReconnect();
      }
    };

    setupRealtime();
    return cleanup;
  }, [selectedAgentId, canSubscribe, forceResubscribeCounter, dispatchMessage, onLoadAgents]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Tab visibility reconnect
  // ═══════════════════════════════════════════════════════════════════════════
  
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && selectedAgentId) {
        if (channelRef.current?.state === 'joined') return;
        setTimeout(() => {
          if (selectedAgentId) {
            setForceResubscribeCounter(prev => prev + 1);
          }
        }, 1000);
      }
    };

    const handleFocus = () => {
      if (selectedAgentId) {
        if (channelRef.current?.state === 'joined') return;
        setTimeout(() => {
          if (selectedAgentId) {
            setForceResubscribeCounter(prev => prev + 1);
          }
        }, 500);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [selectedAgentId]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Clear streaming on pause
  // ═══════════════════════════════════════════════════════════════════════════
  
  useEffect(() => {
    if (agent?.status === 'PAUSED') {
      setStreamingBubbles(new Map());
      setStreamingPlan(null);
      setStreamingTools(new Map());
    }
  }, [agent?.status]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Context Value
  // ═══════════════════════════════════════════════════════════════════════════

  const value: AgentContextValue = {
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
  };

  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════════════════════

export function useAgentContext() {
  const context = useContext(AgentContext);
  if (!context) {
    throw new Error('useAgentContext must be used within AgentProvider');
  }
  return context;
}

export default AgentContext;

