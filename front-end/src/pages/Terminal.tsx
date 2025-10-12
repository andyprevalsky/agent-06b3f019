import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Plus, LogOut, Filter } from 'lucide-react';
import { supabase, signOut, getCurrentUser } from '@/lib/supabase';
import {
  getAllAgents,
  getAgent,
  createAgent as createAgentAPI,
  postMessage as postMessageAPI,
  resumeAgent,
  Agent,
  AgentDetail,
  Message,
  CreateAgentPayload,
} from '@/lib/api';
import CreateAgentModal from '@/components/terminal/CreateAgentModal';
import AgentListItem from '@/components/terminal/AgentListItem';
import MessageBubble from '@/components/terminal/MessageBubble';
import AsciiLoader from '@/components/terminal/AsciiLoader';
import QueryInput from '@/components/terminal/QueryInput';
import AgentSettingsDialog from '@/components/terminal/AgentSettingsDialog';
import { useToast } from '@/hooks/use-toast';
import { useAppData } from '@/hooks/useAppData';
import { cn } from '@/lib/utils';
import { RealtimeChannel } from '@supabase/supabase-js';

function getModelContextWindow(model: string): number {
  const contextWindows: Record<string, number> = {
    'anthropic/claude-sonnet-4.5': 200000,
    'anthropic/claude-4.5-haiku': 200000,
    'openai/gpt-4o': 128000,
    'openai/gpt-4o-mini': 128000,
    'openai/gpt-4-turbo': 128000,
  };
  return contextWindows[model] || 100000;
}

function getContextPercentage(agent: AgentDetail): number {
  const maxWindow = getModelContextWindow(agent.model);
  const restartThreshold = maxWindow * 0.8;
  return Math.min(100, (agent.context_size / restartThreshold) * 100);
}

function deduplicateToolMessages(messages: Message[]): Message[] {
  // Sort messages by timestamp FIRST to ensure correct deduplication order
  const sortedMessages = [...messages].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Track the most recent message for each tool_call_id
  const toolMessageMap = new Map<string, Message>();
  const nonToolMessages: Message[] = [];

  sortedMessages.forEach((message) => {
    if (message.role === 'TOOL') {
      // Parse tool_call_id from message text (format: tool_call_id|||title|||status|||message)
      const parts = message.text.split('|||');
      if (parts.length >= 3) {
        const toolCallId = parts[0];
        // Keep only the most recent message (last one wins, since we sorted chronologically)
        toolMessageMap.set(toolCallId, message);
      } else {
        // Old format or malformed, keep as-is
        nonToolMessages.push(message);
      }
    } else {
      nonToolMessages.push(message);
    }
  });

  // Combine non-tool messages with deduplicated tool messages
  // Already sorted chronologically from the initial sort
  const deduplicatedMessages = [...nonToolMessages, ...Array.from(toolMessageMap.values())];
  deduplicatedMessages.sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return deduplicatedMessages;
}

export default function Terminal() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [user, setUser] = useState<any>(null);
  
  // Agent list state
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [isFirstLoad, setIsFirstLoad] = useState(true);
  const [showCompleted, setShowCompleted] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [resumingAgentId, setResumingAgentId] = useState<string | null>(null);
  
  // Selected agent state
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentDetail, setAgentDetail] = useState<AgentDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingAgent, setIsLoadingAgent] = useState(false);
  
  // Message input state
  const [messageInput, setMessageInput] = useState('');
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [selectedModel, setSelectedModel] = useState('anthropic/claude-sonnet-4.5');
  
  // Models and tools from cached context
  const { models, modelsLoading } = useAppData();
  
  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  
  // Track which message should be animated (only the most recent agent/tool message)
  const [animatingMessageId, setAnimatingMessageId] = useState<string | null>(null);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const lastAnimationStartRef = useRef<number>(0);
  const animatedMessagesRef = useRef<Set<string>>(new Set());
  const isInitialLoadRef = useRef<boolean>(false);

  // Check authentication
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const currentUser = await getCurrentUser();
      if (!currentUser) {
        navigate('/');
        return;
      }
      setUser(currentUser);
    } catch (error) {
      navigate('/');
    }
  };

  // Load agents on mount
  useEffect(() => {
    if (user) {
      loadAgents();
    }
  }, [user]);

  // Poll agents every 10 seconds
  useEffect(() => {
    if (!user) return;

    const intervalId = setInterval(() => {
      loadAgents();
    }, 10000); // 10 seconds

    return () => {
      clearInterval(intervalId);
    };
  }, [user]);

  // Subscribe to realtime updates when agent is selected
  useEffect(() => {
    if (!selectedAgentId || !user) return;

    // Clean up previous channel
    if (channelRef.current) {
      channelRef.current.unsubscribe();
    }

    // Create new channel for selected agent
    const channel = supabase
      .channel(`agent:${selectedAgentId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'Agent',
          filter: `id=eq.${selectedAgentId}`,
        },
        (payload) => {
          console.log('🔄 Agent update:', payload);
          if (payload.eventType === 'UPDATE' && payload.new) {
            // Update agent detail in state directly (no refetch = no flicker)
            const updated = payload.new as any;
            setAgentDetail((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                progress: updated.progress,
                status: updated.status,
                status_message: updated.statusMessage,
                model: updated.model,
                token_count: updated.tokenCount,
                context_size: updated.contextSize,
                message_count: updated.messageCount,
                updated_at: updated.updatedAt,
              };
            });
            // Also refresh agents list to update sidebar
            loadAgents();
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'Message',
          filter: `agentId=eq.${selectedAgentId}`,
        },
        (payload) => {
          console.log('💬 New message:', payload);
          const newMessage = payload.new as any;
          const messageId = newMessage.id;
          const role = newMessage.role;
          
          setMessages((prev) => [
            ...prev,
            {
              message_id: messageId,
              timestamp: newMessage.timestamp,
              text: newMessage.text,
              role: role,
            },
          ]);
          
          // Only queue ASSISTANT messages for animation
          // TOOL messages update instantly with no animation
          if (role === 'ASSISTANT' && !animatedMessagesRef.current.has(messageId)) {
            console.log('🎬 Queuing ASSISTANT message:', messageId.substring(0, 8));
            animatedMessagesRef.current.add(messageId);
            setMessageQueue((prev) => [...prev, messageId]);
          }
        }
      )
      .subscribe((status) => {
        console.log(`📡 Realtime subscription status for agent ${selectedAgentId}:`, status);
        if (status === 'SUBSCRIBED') {
          console.log('✅ Successfully subscribed to realtime updates');
        } else if (status === 'CHANNEL_ERROR') {
          console.error('❌ Realtime subscription error');
        } else if (status === 'TIMED_OUT') {
          console.error('⏱️ Realtime subscription timed out');
        } else if (status === 'CLOSED') {
          console.log('🔌 Realtime subscription closed');
        }
      });

    channelRef.current = channel;

    return () => {
      console.log('🧹 Cleaning up realtime subscription');
      channel.unsubscribe();
    };
  }, [selectedAgentId, user]);

  // Snap to bottom when messages change (only if user was already near bottom)
  useEffect(() => {
    if (!messagesEndRef.current) return;

    // Find the radix scroll area viewport
    const scrollContainer = messagesEndRef.current.closest('[data-radix-scroll-area-viewport]');
    if (!scrollContainer) return;

    // If this is an initial load, SNAP to bottom instantly (no smooth scroll)
    if (isInitialLoadRef.current) {
      // Use requestAnimationFrame to ensure DOM has fully updated
      requestAnimationFrame(() => {
        // Force instant snap by setting scrollTop directly
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        isInitialLoadRef.current = false; // Reset flag after scrolling
      });
      return;
    }

    // Calculate distance from bottom
    const scrollHeight = scrollContainer.scrollHeight;
    const scrollTop = scrollContainer.scrollTop;
    const clientHeight = scrollContainer.clientHeight;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // Only snap to bottom if user was already near bottom (within 150px)
    // This preserves scroll position if user is reading old messages
    if (distanceFromBottom < 150) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }, [messages]);

  // Handler for when animation completes
  const handleAnimationComplete = () => {
    console.log('✅ Animation complete');
    // Remove from queue FIRST, then clear animating ID
    setMessageQueue((prev) => {
      if (prev.length > 0) {
        console.log('🗑️ Removing from queue, remaining:', prev.length - 1);
        return prev.slice(1);
      }
      return prev;
    });
    // Delay before clearing to ensure queue update processes
    setTimeout(() => {
      setAnimatingMessageId(null);
    }, 1000);
  };

  // Process message queue with minimum 200ms delay between animations
  useEffect(() => {
    if (messageQueue.length > 0 && !animatingMessageId) {
      const now = Date.now();
      const timeSinceLastAnimation = now - lastAnimationStartRef.current;
      const minDelay = 200;

      if (timeSinceLastAnimation >= minDelay || lastAnimationStartRef.current === 0) {
        // Start animating immediately
        lastAnimationStartRef.current = now;
        const msgId = messageQueue[0];
        console.log('▶️ Starting animation:', msgId.substring(0, 8));
        setAnimatingMessageId(msgId);
      } else {
        // Wait for remaining time
        const remainingDelay = minDelay - timeSinceLastAnimation;
        const timeout = setTimeout(() => {
          lastAnimationStartRef.current = Date.now();
          const msgId = messageQueue[0];
          console.log('▶️ Starting animation (delayed):', msgId.substring(0, 8));
          setAnimatingMessageId(msgId);
        }, remainingDelay);
        return () => clearTimeout(timeout);
      }
    }
  }, [messageQueue, animatingMessageId]);

  // Check if we should show the loader (agent is thinking)
  const [showThinkingLoader, setShowThinkingLoader] = useState(false);
  
  useEffect(() => {
    // Don't show loader if:
    // - No agent detail
    // - Agent is not active
    // - We're currently animating a message
    if (!agentDetail || 
        agentDetail.status === 'COMPLETED' || 
        agentDetail.status === 'FAILED' || 
        agentDetail.status === 'PAUSED' ||
        animatingMessageId) {
      setShowThinkingLoader(false);
      return;
    }

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
      setShowThinkingLoader(false);
      return;
    }

    // Check if last message is a tool with IN_PROGRESS status
    if (lastMessage.role === 'TOOL') {
      const parts = lastMessage.text.split('|||');
      if (parts.length >= 3 && parts[2] === 'IN_PROGRESS') {
        setShowThinkingLoader(false);
        return;
      }
    }

    // Track when we last saw this message (use local time to avoid clock sync issues)
    let lastSeenTime = Date.now();

    // Check every 100ms to ensure we don't miss the threshold
    const checkThreshold = () => {
      const timeSinceWeFirstSawMessage = Date.now() - lastSeenTime;
      const shouldShow = timeSinceWeFirstSawMessage > 500;
      setShowThinkingLoader(shouldShow);
    };

    // Check immediately
    checkThreshold();

    // Then check every 100ms
    const interval = setInterval(checkThreshold, 100);
    
    return () => clearInterval(interval);
  }, [messages, agentDetail, animatingMessageId]);

  const loadAgents = async () => {
    try {
      // Only show loading state on first load
      if (isFirstLoad) {
        setIsLoadingAgents(true);
      }
      const fetchedAgents = await getAllAgents();
      setAgents(fetchedAgents);
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load agents',
        variant: 'destructive',
      });
    } finally {
      if (isFirstLoad) {
        setIsLoadingAgents(false);
        setIsFirstLoad(false);
      }
    }
  };

  const loadAgentDetail = async (agentId: string) => {
    try {
      setIsLoadingAgent(true);
      const data = await getAgent(agentId);
      setAgentDetail(data.agent);
      setMessages(data.messages); // Already in chronological order (oldest first)
      setSelectedModel(data.agent.model); // Sync UI model with agent's actual model
      
      // Mark this as an initial load so we can scroll to bottom
      isInitialLoadRef.current = true;
      
      // Clear animation state and queue when loading a different agent
      setAnimatingMessageId(null);
      setMessageQueue([]);
      lastAnimationStartRef.current = 0;
      animatedMessagesRef.current.clear();
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load agent details',
        variant: 'destructive',
      });
    } finally {
      setIsLoadingAgent(false);
    }
  };

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    loadAgentDetail(agentId);
  };

  const handleCreateAgent = async (data: CreateAgentPayload) => {
    const newAgent = await createAgentAPI(data);
    await loadAgents();
    setSelectedAgentId(newAgent.agent_id);
    loadAgentDetail(newAgent.agent_id);
  };

  const handleResumeAgent = async (agentId: string) => {
    try {
      setResumingAgentId(agentId);
      await resumeAgent(agentId);
      
      // If this is the currently selected agent, reload its details
      if (agentId === selectedAgentId) {
        await loadAgentDetail(agentId);
      }
      
      // Refresh the agents list to show updated status
      await loadAgents();
      
      toast({
        title: 'Success',
        description: 'Agent resumed',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to resume agent',
        variant: 'destructive',
      });
    } finally {
      setResumingAgentId(null);
    }
  };

  const handleSendMessage = async () => {
    if (!messageInput.trim() || !selectedAgentId) return;

    try {
      setIsSendingMessage(true);
      await postMessageAPI(selectedAgentId, messageInput);
      // Don't add message here - let Realtime subscription handle it to avoid duplicates
      setMessageInput('');
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to send message',
        variant: 'destructive',
      });
    } finally {
      setIsSendingMessage(false);
    }
  };


  const handleLogout = async () => {
    try {
      await signOut();
      navigate('/');
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to log out',
        variant: 'destructive',
      });
    }
  };

  const filteredAgents = agents.filter((agent) => {
    if (showCompleted) {
      return agent.status === 'COMPLETED';
    }
    return agent.status !== 'COMPLETED';
  });

  const sortedAgents = [...filteredAgents].sort((a, b) => {
    // Paused agents go to the bottom
    if (a.status === 'PAUSED' && b.status !== 'PAUSED') return 1;
    if (a.status !== 'PAUSED' && b.status === 'PAUSED') return -1;
    // Otherwise sort by progress (descending)
    return b.progress - a.progress;
  });

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  // Show loader when agent is working (not used for now since we don't have STATUS role)
  const showStatusLoader = false;

  // Get system messages
  const systemMessages = messages.filter((m) => m.role === 'SYSTEM');

  return (
    <div className="h-screen w-screen flex flex-col bg-background dark:bg-navi-black">
      {/* Header */}
      <header className="h-16 border-b border-border dark:border-navi-light-black flex items-center justify-between px-6 bg-card dark:bg-navi-black flex-shrink-0">
        <a
          href="/"
          className="flex items-center space-x-3 hover:opacity-80 transition-opacity"
        >
          <div
            className="w-8 h-8 rounded-lg"
            style={{
              background:
                'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
            }}
          ></div>
          <span className="text-xl font-semibold tracking-tight">Navi</span>
        </a>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <aside className="w-80 border-r border-border dark:border-navi-light-black bg-card dark:bg-navi-black flex flex-col">
          {/* Create Agent Button */}
          <div className="p-4 border-b border-border dark:border-navi-light-black">
            <Button
              onClick={() => setCreateModalOpen(true)}
              className="w-full"
              size="lg"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Agent
            </Button>
          </div>

          {/* Filter Toggle */}
          <div className="px-4 py-3 border-b border-border dark:border-navi-light-black">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCompleted(!showCompleted)}
              className="w-full justify-start"
            >
              <Filter className="h-4 w-4 mr-2" />
              {showCompleted ? 'Show In Progress' : 'Show Completed'}
            </Button>
          </div>

          {/* Agent List */}
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-2">
              {isLoadingAgents && agents.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : sortedAgents.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  {showCompleted
                    ? 'No completed agents yet'
                    : 'No agents in progress'}
                </div>
              ) : (
                sortedAgents.map((agent) => (
                  <AgentListItem
                    key={agent.agent_id}
                    agent={agent}
                    isSelected={selectedAgentId === agent.agent_id}
                    onClick={() => handleSelectAgent(agent.agent_id)}
                    onResume={handleResumeAgent}
                    isResuming={resumingAgentId === agent.agent_id}
                  />
                ))
              )}
            </div>
          </ScrollArea>

          {/* Logout Button */}
          <div className="p-4 border-t border-border dark:border-navi-light-black">
            <Button
              variant="outline"
              onClick={handleLogout}
              className="w-full justify-start"
            >
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </Button>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col relative">
          {/* Settings Button - Top Right */}
          {selectedAgentId && agentDetail && (
            <div className="absolute top-4 right-4 z-20">
              <AgentSettingsDialog agent={agentDetail} onUpdate={() => loadAgentDetail(selectedAgentId)} />
            </div>
          )}
          
          {/* System Messages - Top Right */}
          {selectedAgentId && systemMessages.length > 0 && (
            <div className="absolute top-4 right-16 max-w-md z-10">
              <div className="bg-card dark:bg-navi-light-black border border-border dark:border-navi-light-light-black rounded-lg p-4 shadow-lg">
                <h3 className="text-sm font-semibold mb-2">System Messages</h3>
                <ScrollArea className="max-h-48">
                  <div className="space-y-2">
                    {systemMessages.map((msg) => (
                      <div
                        key={msg.message_id}
                        className="text-xs p-2 bg-blue-500/10 dark:bg-blue-500/20 border border-blue-500/30 rounded"
                      >
                        <p>{msg.text}</p>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </div>
          )}

          {/* Main Content Area */}
          <ScrollArea className="flex-1 px-6 py-4">
            {(!selectedAgentId || isLoadingAgent || agentDetail?.status === 'STARTING_UP') && !(agentDetail?.status === 'PAUSED' || agentDetail?.status === 'ACTIVE' || agentDetail?.status === 'COMPLETED' || agentDetail?.status === 'FAILED') ? (
              // Show ASCII animation when: no agent selected, loading agent, or agent starting up (but not when paused/active/completed/failed)
              <div className="flex items-center justify-center h-full">
                <div className="text-center space-y-6">
                    <AsciiLoader showWarmingUp={false} size="large" variant="engine" />
                  <div>
                    {!selectedAgentId ? (
                      // No agent selected states
                      isLoadingAgents ? (
                        <p className="text-muted-foreground">
                          getting agents <span className="inline-block w-6 animate-dots" />
                        </p>
                      ) : agents.length === 0 ? (
                        <>
                          <p className="text-xl font-semibold mb-2">Navi Says,</p>
                          <p className="text-muted-foreground">Make Your First Agent!</p>
                        </>
                      ) : (
                        <p className="text-muted-foreground">
                          {sortedAgents.length} {sortedAgents.length === 1 ? 'agent' : 'agents'} in progress <span className="inline-block w-6 animate-dots" />
                        </p>
                      )
                    ) : isLoadingAgent ? (
                      // Loading agent data
                      <p className="text-muted-foreground">
                        loading agent <span className="inline-block w-6 animate-dots" />
                      </p>
                    ) : (
                      // Agent starting up
                      <p className="text-muted-foreground">
                        agent starting up <span className="inline-block w-6 animate-dots" />
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              // Agent selected - show messages
              <div className="max-w-4xl mx-auto space-y-4 pb-32">
                {deduplicateToolMessages(messages.filter((m) => m.role !== 'SYSTEM')).map((message) => (
                  <MessageBubble 
                    key={message.message_id} 
                    message={message}
                    shouldType={message.message_id === animatingMessageId}
                    onTypingComplete={handleAnimationComplete}
                  />
                ))}
                
                {/* Show paused text when agent is paused */}
                {agentDetail?.status === 'PAUSED' && (
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8" />
                    <p className="text-sm text-muted-foreground">agent is paused</p>
                  </div>
                )}
                
                {/* Show completed text when agent is complete */}
                {agentDetail?.status === 'COMPLETED' && (
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8" />
                    <p className="text-sm text-muted-foreground">your goal is complete</p>
                  </div>
                )}
                
                {/* Show small ASCII loader when agent is thinking */}
                {showThinkingLoader && (
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8" />
                    <AsciiLoader showWarmingUp={false} size="icon" fitContainer />
                  </div>
                )}
                
                <div ref={messagesEndRef} />
              </div>
            )}
          </ScrollArea>

          {/* Message Input - Only show for active agents */}
          {selectedAgentId && agentDetail && !['COMPLETED', 'FAILED'].includes(agentDetail.status) && (
            <div className="p-6">
              <QueryInput
                value={messageInput}
                onChange={setMessageInput}
                onSubmit={handleSendMessage}
                disabled={isSendingMessage || !selectedAgentId}
                placeholder="Type your message..."
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                availableModels={models}
                modelsLoading={modelsLoading}
                contextPercentage={getContextPercentage(agentDetail)}
                contextSize={agentDetail.context_size}
                restartThreshold={getModelContextWindow(agentDetail.model) * 0.8}
              />
            </div>
          )}
        </main>
      </div>

      {/* Create Agent Modal */}
      <CreateAgentModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onSubmit={handleCreateAgent}
      />
    </div>
  );
}

