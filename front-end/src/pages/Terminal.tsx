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
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { RealtimeChannel } from '@supabase/supabase-js';

export default function Terminal() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [user, setUser] = useState<any>(null);
  
  // Agent list state
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [showCompleted, setShowCompleted] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  
  // Selected agent state
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentDetail, setAgentDetail] = useState<AgentDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingAgent, setIsLoadingAgent] = useState(false);
  
  // Message input state
  const [messageInput, setMessageInput] = useState('');
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [selectedModel, setSelectedModel] = useState('gpt-4o');
  
  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

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
          console.log('Agent update:', payload);
          if (payload.eventType === 'UPDATE') {
            // Refresh agent detail
            loadAgentDetail(selectedAgentId);
            // Also refresh agents list to update progress
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
          console.log('New message:', payload);
          // Add new message to list
          const newMessage = payload.new as any;
          setMessages((prev) => [
            {
              message_id: newMessage.id,
              timestamp: newMessage.timestamp,
              text: newMessage.text,
              role: newMessage.role,
            },
            ...prev,
          ]);
        }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
    };
  }, [selectedAgentId, user]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadAgents = async () => {
    try {
      setIsLoadingAgents(true);
      const fetchedAgents = await getAllAgents();
      setAgents(fetchedAgents);
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load agents',
        variant: 'destructive',
      });
    } finally {
      setIsLoadingAgents(false);
    }
  };

  const loadAgentDetail = async (agentId: string) => {
    try {
      setIsLoadingAgent(true);
      const data = await getAgent(agentId);
      setAgentDetail(data.agent);
      setMessages(data.messages.reverse()); // Reverse to show oldest first
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

  const handleSendMessage = async () => {
    if (!messageInput.trim() || !selectedAgentId) return;

    try {
      setIsSendingMessage(true);
      const message = await postMessageAPI(selectedAgentId, messageInput);
      setMessages((prev) => [...prev, message]);
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
    // Sort by progress (descending)
    return b.progress - a.progress;
  });

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const showStatusLoader = lastMessage?.role === 'STATUS';

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
          {/* System Messages - Top Right */}
          {selectedAgentId && systemMessages.length > 0 && (
            <div className="absolute top-4 right-4 max-w-md z-10">
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
            {!selectedAgentId || isLoadingAgent || agentDetail?.status === 'STARTING_UP' ? (
              // Show ASCII animation when: no agent selected, loading agent, or agent starting up
              <div className="flex items-center justify-center h-full">
                <div className="text-center space-y-6">
                  <div className="w-48 h-48 mx-auto flex items-center justify-center">
                    <AsciiLoader showWarmingUp={false} size="normal" />
                  </div>
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
                        {agentDetail?.status_message || 'agent starting up'} <span className="inline-block w-6 animate-dots" />
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              // Agent selected and active - show messages
              <div className="max-w-4xl mx-auto space-y-4">
                {messages.filter((m) => m.role !== 'SYSTEM').map((message) => (
                  <MessageBubble key={message.message_id} message={message} />
                ))}
                {showStatusLoader && lastMessage && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm">{lastMessage.text}</span>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </ScrollArea>

          {/* Message Input - Always in DOM, visible when agent is selected */}
          <div className={cn("p-6", !selectedAgentId && "invisible")}>
            <QueryInput
              value={messageInput}
              onChange={setMessageInput}
              onSubmit={handleSendMessage}
              disabled={isSendingMessage || !selectedAgentId}
              placeholder="Type your message..."
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
            />
          </div>
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

