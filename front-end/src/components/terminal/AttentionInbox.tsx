import { useState, useEffect, useRef } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabase';
import { MarkdownText } from './MarkdownText';
import type { RealtimeChannel } from '@supabase/supabase-js';

// API Configuration - match pattern used in lib/api.ts
const API_BASE_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_BASE_WITH_PATH = API_BASE_URL.endsWith('/api') ? API_BASE_URL : `${API_BASE_URL}/api`;

interface AttentionRequest {
  id: string;
  agent_id: string;
  workflow_id: string;
  question: string;
  image_url?: string | null;
  user_response?: string | null;
  created_at: string;
  updated_at: string;
  answered: boolean;
}

interface AttentionInboxProps {
  onSelectAgent?: (agentId: string) => void;
}

export default function AttentionInbox({ onSelectAgent }: AttentionInboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [requests, setRequests] = useState<AttentionRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const { toast } = useToast();

  // Realtime subscription refs
  const channelRef = useRef<RealtimeChannel | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const [forceResubscribe, setForceResubscribe] = useState(0);

  // Fetch requests
  const fetchRequests = async () => {
    try {
      const session = await supabase.auth.getSession();
      if (!session.data.session) return;

      const response = await fetch(
        `${API_BASE_WITH_PATH}/attention-requests`,
        {
          headers: {
            'Authorization': `Bearer ${session.data.session.access_token}`,
          },
        }
      );

      if (!response.ok) throw new Error('Failed to fetch requests');

      const data = await response.json();
      console.log('📥 Fetched attention requests:', data.requests.length, 'total,', data.requests.filter((r: any) => !r.answered).length, 'unanswered');
      setRequests(data.requests || []);
    } catch (error) {
      console.error('Failed to fetch attention requests:', error);
    }
  };

  // Fetch immediately on mount (before websocket connects)
  useEffect(() => {
    fetchRequests();
  }, []);

  // Set up real-time subscription for attention requests
  useEffect(() => {
    const setupRealtimeSubscription = async () => {
      const session = await supabase.auth.getSession();
      const userId = session.data.session?.user?.id;
      if (!userId) return;

      // Clean up existing channel
      if (channelRef.current) {
        console.log('🧹 Cleaning up existing attention requests channel');
        await supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      // Clear any pending reconnect timeout
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      console.log('📡 Creating realtime channel for attention requests');

      // Create new channel for attention requests
      const channel = supabase
        .channel(`attention-requests:${userId}:${Date.now()}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'AgentAttentionRequest',
            filter: `userId=eq.${userId}`,
          },
          (payload) => {
            console.log('🔔 Attention request update:', payload);
            
            if (payload.eventType === 'INSERT') {
              // New request - add to list
              const newRequest = payload.new as any;
              const request: AttentionRequest = {
                id: newRequest.id,
                agent_id: newRequest.agentId,
                workflow_id: newRequest.workflowId,
                question: newRequest.question,
                image_url: newRequest.imageUrl,
                user_response: newRequest.userResponse,
                created_at: newRequest.createdAt,
                updated_at: newRequest.updatedAt,
                answered: !!newRequest.userResponse,
              };
              setRequests((prev) => [request, ...prev]);
            } else if (payload.eventType === 'UPDATE') {
              // Request updated (likely answered)
              const updated = payload.new as any;
              setRequests((prev) =>
                prev.map((req) =>
                  req.id === updated.id
                    ? {
                        ...req,
                        user_response: updated.userResponse,
                        updated_at: updated.updatedAt,
                        answered: !!updated.userResponse,
                      }
                    : req
                )
              );
            } else if (payload.eventType === 'DELETE') {
              // Request deleted
              const deleted = payload.old as any;
              setRequests((prev) => prev.filter((req) => req.id !== deleted.id));
            }
          }
        )
        .subscribe(async (status) => {
          console.log('📡 Attention requests subscription status:', status);

          if (status === 'SUBSCRIBED') {
            console.log('✅ Successfully subscribed to attention requests');
            // Reset reconnection attempts on successful connection
            reconnectAttemptRef.current = 0;

            // Fetch initial data to catch any requests created before subscription
            try {
              await fetchRequests();
            } catch (error) {
              console.error('Failed to fetch initial requests:', error);
            }
          } else if (status === 'CHANNEL_ERROR') {
            console.error('❌ Attention requests subscription error - will retry');
            scheduleReconnect();
          } else if (status === 'TIMED_OUT') {
            console.error('⏱️ Attention requests subscription timed out - will retry');
            scheduleReconnect();
          } else if (status === 'CLOSED') {
            console.log('🔌 Attention requests subscription closed - will retry');
            scheduleReconnect();
          }
        });

      channelRef.current = channel;

      // Helper function to schedule reconnection with exponential backoff
      function scheduleReconnect() {
        if (!userId) return;

        // Clear any existing timeout
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
        const attempt = reconnectAttemptRef.current;
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000);

        console.log(`🔄 Scheduling attention requests reconnection attempt ${attempt + 1} in ${delay}ms...`);
        reconnectAttemptRef.current += 1;

        reconnectTimeoutRef.current = window.setTimeout(() => {
          console.log(`🔄 Attempting to reconnect attention requests (attempt ${attempt + 1})...`);
          setForceResubscribe((prev) => prev + 1);
        }, delay);
      }
    };

    setupRealtimeSubscription();

    return () => {
      console.log('🧹 Cleaning up attention requests subscription');
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [forceResubscribe]);

  // Fetch when modal is opened (for latest state)
  useEffect(() => {
    if (isOpen) {
      fetchRequests();
    }
  }, [isOpen]);

  // Get unanswered count
  const unansweredCount = requests.filter(r => !r.answered).length;

  // Handle respond
  const handleRespond = async (requestId: string) => {
    const response = responses[requestId];
    if (!response?.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a response',
        variant: 'destructive',
      });
      return;
    }

    try {
      setLoading(true);
      const session = await supabase.auth.getSession();
      if (!session.data.session) return;

      // Count remaining requests before responding
      const remainingBeforeResponse = requests.filter(r => !r.answered && r.id !== requestId).length;

      const res = await fetch(
        `${API_BASE_WITH_PATH}/attention-requests/${requestId}/respond`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.data.session.access_token}`,
          },
          body: JSON.stringify({ response }),
        }
      );

      if (!res.ok) throw new Error('Failed to respond');

      // Clear the response
      setResponses(prev => {
        const newResponses = { ...prev };
        delete newResponses[requestId];
        return newResponses;
      });

      // Refetch to get updated list
      console.log('🔄 Refetching requests after respond...');
      await fetchRequests();
      console.log('✅ Refetch complete');

      // Keep modal open
      setIsOpen(true);
      
      // Show appropriate toast message
      if (remainingBeforeResponse > 0) {
        toast({
          title: 'Response sent',
          description: `${remainingBeforeResponse} more ${remainingBeforeResponse === 1 ? 'request' : 'requests'} waiting`,
        });
      } else {
        toast({
          title: 'Response sent',
          description: 'The agent will continue with your response',
        });
      }
    } catch (error) {
      console.error('Failed to respond:', error);
      toast({
        title: 'Error',
        description: 'Failed to send response',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  // Handle skip
  const handleSkip = async (requestId: string) => {
    try {
      setLoading(true);
      const session = await supabase.auth.getSession();
      if (!session.data.session) return;

      // Count remaining requests before skipping
      const remainingBeforeSkip = requests.filter(r => !r.answered && r.id !== requestId).length;

      const res = await fetch(
        `${API_BASE_WITH_PATH}/attention-requests/${requestId}/skip`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.data.session.access_token}`,
          },
        }
      );

      if (!res.ok) throw new Error('Failed to skip');

      // Clear the response if any
      setResponses(prev => {
        const newResponses = { ...prev };
        delete newResponses[requestId];
        return newResponses;
      });

      // Refetch to get updated list
      console.log('🔄 Refetching requests after skip...');
      await fetchRequests();
      console.log('✅ Refetch complete');

      // Keep modal open
      setIsOpen(true);
      
      // Show appropriate toast message
      if (remainingBeforeSkip > 0) {
        toast({
          title: 'Request skipped',
          description: `${remainingBeforeSkip} more ${remainingBeforeSkip === 1 ? 'request' : 'requests'} waiting`,
        });
      } else {
        toast({
          title: 'Request skipped',
          description: 'No more pending requests',
        });
      }
    } catch (error) {
      console.error('Failed to skip:', error);
      toast({
        title: 'Error',
        description: 'Failed to skip request',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Get the first unanswered request
      const firstUnanswered = requests.find(r => !r.answered);
      if (!firstUnanswered) return;

      // Cmd/Ctrl + Enter: Submit response
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleRespond(firstUnanswered.id);
      }

      // Cmd/Ctrl + S: Skip
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSkip(firstUnanswered.id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, requests, responses]);

  return (
    <div className="relative">
      {/* Inbox Button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setIsOpen(!isOpen)}
        className="relative rounded-2xl"
      >
        <Bell className="h-5 w-5" />
        {unansweredCount > 0 && (
          <span
            className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center rounded-lg text-xs font-semibold text-white"
            style={{ 
              background: '#FC585C',
              boxShadow: '0 2px 8px rgba(252, 88, 92, 0.4)'
            }}
          >
            {unansweredCount}
          </span>
        )}
      </Button>

      {/* Modal */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />

          {/* Modal content */}
          <div className="absolute top-12 right-0 z-50 w-[500px] bg-card dark:bg-navi-black border border-border dark:border-navi-light-black rounded-lg shadow-lg">
            <div className="p-4 space-y-4">
              {requests.filter(r => !r.answered).length === 0 ? (
                <div className="text-center py-8 space-y-2">
                  <p className="text-sm font-medium text-foreground">
                    🎉 Congrats!
                  </p>
                  <p className="text-sm text-muted-foreground">
                    All your agents are unblocked and busy working on your goals.
                  </p>
                </div>
              ) : (
                // Show only the first (oldest) unanswered request
                (() => {
                  const unansweredRequests = requests.filter(r => !r.answered);
                  const currentRequest = unansweredRequests[0];
                  const remainingCount = unansweredRequests.length - 1;
                  
                  console.log('🎯 Rendering current request:', currentRequest?.id, 'Remaining:', remainingCount);
                  
                  if (!currentRequest) return null;
                  
                  return (
                    <div key={currentRequest.id} className="space-y-3">
                      {/* Remaining requests indicator */}
                      {remainingCount > 0 && (
                        <div className="text-xs text-muted-foreground text-center py-1 px-2 bg-muted/50 rounded">
                          {remainingCount} more {remainingCount === 1 ? 'request' : 'requests'} waiting
                        </div>
                      )}
                      
                      {/* Image thumbnail if present */}
                      {currentRequest.image_url && (
                        <div className="flex justify-center">
                          <img 
                            src={currentRequest.image_url} 
                            alt="Product thumbnail"
                            className="max-w-[200px] max-h-[200px] rounded-md object-contain"
                          />
                        </div>
                      )}

                      {/* Question rendered as markdown */}
                      <div>
                        <MarkdownText text={currentRequest.question} />
                      </div>

                      {/* Link to agent */}
                      <Button
                        variant="link"
                        size="sm"
                        className="p-0 h-auto text-xs"
                        onClick={() => {
                          if (onSelectAgent) {
                            onSelectAgent(currentRequest.agent_id);
                            setIsOpen(false);
                          }
                        }}
                      >
                        View agent →
                      </Button>

                      {/* Response textarea */}
                      <Textarea
                        placeholder="Type your response..."
                        value={responses[currentRequest.id] || ''}
                        onChange={(e) =>
                          setResponses((prev) => ({
                            ...prev,
                            [currentRequest.id]: e.target.value,
                          }))
                        }
                        className="min-h-[80px]"
                      />

                      {/* Actions */}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleRespond(currentRequest.id)}
                          disabled={loading || !responses[currentRequest.id]?.trim()}
                        >
                          Respond (⌘↵)
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleSkip(currentRequest.id)}
                          disabled={loading}
                        >
                          Skip (⌘S)
                        </Button>
                      </div>

                      {/* Timestamp */}
                      <p className="text-xs text-muted-foreground">
                        Asked{' '}
                        {new Date(currentRequest.created_at).toLocaleString()}
                      </p>
                    </div>
                  );
                })()
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}


