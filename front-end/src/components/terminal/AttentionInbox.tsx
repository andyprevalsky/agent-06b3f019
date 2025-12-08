import { useState, useEffect, useRef } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { supabase, getStoredSession } from '@/lib/supabase';
import { respondToAttentionRequest, skipAttentionRequest } from '@/lib/api';
import { subscribeToAttentionRequests, unsubscribe } from '@/lib/realtime';
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
  metadata?: Record<string, any> | null;
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
  const [actionRequestId, setActionRequestId] = useState<string | null>(null);
  const { toast } = useToast();

  // Realtime subscription refs
  const channelRef = useRef<RealtimeChannel | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const [forceResubscribe, setForceResubscribe] = useState(0);

  // Fetch requests
  const fetchRequests = async () => {
    try {
      const session = getStoredSession();
      if (!session?.access_token) return;

      const response = await fetch(
        `${API_BASE_WITH_PATH}/attention-requests`,
        {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
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
  // Also poll every 10 seconds as fallback since backend doesn't send broadcasts
  useEffect(() => {
    fetchRequests();
    
    // Poll every 10 seconds to catch new attention requests
    // This is a fallback since the backend doesn't broadcast to Supabase
    const pollInterval = setInterval(() => {
      fetchRequests();
    }, 10000);
    
    return () => clearInterval(pollInterval);
  }, []);

  // Set up real-time subscription for attention requests
  useEffect(() => {
    const setupRealtimeSubscription = async () => {
      const session = getStoredSession();
      const userId = session?.user?.id;
      if (!userId) return;

      if (session?.access_token) {
        await supabase.realtime.setAuth(session.access_token);
      }

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

      // Subscribe to attention requests using clean subscription pattern
      try {
        const channel = await subscribeToAttentionRequests(userId, {
          onInsert: (payload) => {
            // Data is in payload.record
            const data = payload.payload?.record;
            if (!data) return;
            
            const request: AttentionRequest = {
              id: data.id,
              agent_id: data.agentId,
              workflow_id: data.workflowId,
              question: data.question,
              image_url: data.imageUrl,
              metadata: data.metadata,
              user_response: data.userResponse,
              created_at: data.createdAt,
              updated_at: data.updatedAt,
              answered: !!data.userResponse,
            };
            setRequests((prev) => [request, ...prev]);
          },
          onUpdate: (payload) => {
            // Data is in payload.record or payload.payload.record
            const data = payload.record || payload.payload?.record;
            if (!data) return;
            
            setRequests((prev) =>
              prev.map((req) =>
                req.id === data.id
                  ? {
                      ...req,
                      user_response: data.userResponse,
                      updated_at: data.updatedAt,
                      metadata: data.metadata ?? req.metadata,
                      answered: !!data.userResponse,
                    }
                  : req
              )
            );
          },
          onDelete: (payload) => {
            // Data is in payload.record or payload.payload.record
            const data = payload.record || payload.payload?.record;
            if (!data) return;
            
            setRequests((prev) => prev.filter((req) => req.id !== data.id));
          },
        });

        channelRef.current = channel;
        
        // Reset reconnection state
        reconnectAttemptRef.current = 0;

        // Fetch initial data
        try {
          await fetchRequests();
        } catch (error) {
          console.error('Failed to fetch initial requests:', error);
        }
      } catch (error) {
        console.error('Failed to subscribe to attention requests:', error);
        scheduleReconnect();
      }

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

        reconnectAttemptRef.current += 1;

        reconnectTimeoutRef.current = window.setTimeout(() => {
          setForceResubscribe((prev) => prev + 1);
        }, delay);
      }
    };

    setupRealtimeSubscription();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      unsubscribe(channelRef.current);
      channelRef.current = null;
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
  const handleRespond = async (requestId: string, overrideResponse?: string) => {
    const response = overrideResponse ?? responses[requestId];
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
      // Count remaining requests before responding
      const remainingBeforeResponse = requests.filter(r => !r.answered && r.id !== requestId).length;

      await respondToAttentionRequest(requestId, response);

      // Clear the response
      setResponses(prev => {
        const newResponses = { ...prev };
        if (!overrideResponse) {
          delete newResponses[requestId];
        }
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
      // Count remaining requests before skipping
      const remainingBeforeSkip = requests.filter(r => !r.answered && r.id !== requestId).length;

      await skipAttentionRequest(requestId);

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

  const handleSendViaIMessage = async (request: AttentionRequest) => {
    const metadata = request.metadata || {};
    if (metadata.onSuccess !== 'sendSmsThroughIMessage') {
      toast({
        title: 'Unsupported action',
        description: 'This request cannot be completed automatically.',
        variant: 'destructive',
      });
      return;
    }

    const to = metadata.to;
    const message = metadata.message;

    if (!to || !message) {
      toast({
        title: 'Missing details',
        description: 'Recipient or message is missing from the request.',
        variant: 'destructive',
      });
      return;
    }

    const bridge = (typeof window !== 'undefined' ? (window as any).api : undefined);
    if (!bridge?.sendIMessage) {
      toast({
        title: 'Mac app required',
        description: 'Open the Rose Mac app to send this iMessage automatically.',
        variant: 'destructive',
      });
      return;
    }

    try {
      setActionRequestId(request.id);
      const result = await bridge.sendIMessage({ to, message });
      if (result && result.success === false) {
        throw new Error(result.message || 'iMessage send failed');
      }

      await respondToAttentionRequest(request.id, 'Message sent via Mac app ✅');
      toast({
        title: 'iMessage sent',
        description: 'Your approval was recorded and the agent will continue.',
      });
      await fetchRequests();
    } catch (error) {
      console.error('Failed to send via iMessage:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send via iMessage',
        variant: 'destructive',
      });
    } finally {
      setActionRequestId(null);
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

                      {/* Automated action for send_sms_as_user */}
                      {currentRequest.metadata?.onSuccess === 'sendSmsThroughIMessage' && (
                        <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-semibold text-primary">
                              Send via iMessage on your Mac
                            </p>
                            <span className="text-xs text-muted-foreground">
                              Requires Mac app
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground space-y-1">
                            <p><span className="font-semibold">To:</span> {currentRequest.metadata?.to}</p>
                            <p className="whitespace-pre-wrap">
                              <span className="font-semibold">Message:</span> {currentRequest.metadata?.message}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={
                              actionRequestId === currentRequest.id ||
                              loading ||
                              !(typeof window !== 'undefined' && (window as any)?.api?.sendIMessage)
                            }
                            onClick={() => handleSendViaIMessage(currentRequest)}
                          >
                            {(() => {
                              const hasBridge = typeof window !== 'undefined' && (window as any)?.api?.sendIMessage;
                              if (!hasBridge) return 'Open Mac app to send';
                              if (actionRequestId === currentRequest.id) return 'Sending...';
                              return 'Send via iMessage';
                            })()}
                          </Button>
                        </div>
                      )}

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


