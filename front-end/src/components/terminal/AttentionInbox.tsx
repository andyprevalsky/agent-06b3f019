import { useState, useEffect } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabase';

interface AttentionRequest {
  id: string;
  agent_id: string;
  workflow_id: string;
  question: string;
  context?: any;
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

  // Fetch requests
  const fetchRequests = async () => {
    try {
      const session = await supabase.auth.getSession();
      if (!session.data.session) return;

      const response = await fetch(
        `${import.meta.env.VITE_BACKEND_URL}/api/attention-requests`,
        {
          headers: {
            'Authorization': `Bearer ${session.data.session.access_token}`,
          },
        }
      );

      if (!response.ok) throw new Error('Failed to fetch requests');

      const data = await response.json();
      setRequests(data.requests || []);
    } catch (error) {
      console.error('Failed to fetch attention requests:', error);
    }
  };

  // Fetch on mount and when opened
  useEffect(() => {
    fetchRequests();
  }, []);

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

      const res = await fetch(
        `${import.meta.env.VITE_BACKEND_URL}/api/attention-requests/${requestId}/respond`,
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

      toast({
        title: 'Response sent',
        description: 'The agent will continue with your response',
      });

      // Clear the response
      setResponses(prev => {
        const newResponses = { ...prev };
        delete newResponses[requestId];
        return newResponses;
      });

      // Refresh requests
      await fetchRequests();
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
      const session = await supabase.auth.getSession();
      if (!session.data.session) return;

      const res = await fetch(
        `${import.meta.env.VITE_BACKEND_URL}/api/attention-requests/${requestId}/skip`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.data.session.access_token}`,
          },
        }
      );

      if (!res.ok) throw new Error('Failed to skip');

      // Refresh requests
      await fetchRequests();
    } catch (error) {
      console.error('Failed to skip:', error);
      toast({
        title: 'Error',
        description: 'Failed to skip request',
        variant: 'destructive',
      });
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
        className="relative"
      >
        <Bell className="h-5 w-5" />
        {unansweredCount > 0 && (
          <Badge
            variant="destructive"
            className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs"
          >
            {unansweredCount}
          </Badge>
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
          <div className="absolute top-12 right-0 z-50 w-[500px] max-h-[600px] bg-card dark:bg-navi-black border border-border dark:border-navi-light-black rounded-lg shadow-lg overflow-hidden">
            <div className="p-4 border-b border-border dark:border-navi-light-black">
              <h2 className="text-lg font-semibold">Agent Attention Requests</h2>
              <p className="text-sm text-muted-foreground">
                {unansweredCount} unanswered
              </p>
            </div>

            <ScrollArea className="h-[500px]">
              <div className="p-4 space-y-4">
                {requests.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No attention requests
                  </p>
                ) : (
                  requests
                    .filter(r => !r.answered)
                    .map((request) => (
                      <div
                        key={request.id}
                        className="p-4 border border-border dark:border-navi-light-black rounded-lg space-y-3"
                      >
                        {/* Question */}
                        <div>
                          <p className="text-sm font-medium mb-2">Question:</p>
                          <p className="text-sm text-muted-foreground">
                            {request.question}
                          </p>
                        </div>

                        {/* Link to agent */}
                        <Button
                          variant="link"
                          size="sm"
                          className="p-0 h-auto text-xs"
                          onClick={() => {
                            if (onSelectAgent) {
                              onSelectAgent(request.agent_id);
                              setIsOpen(false);
                            }
                          }}
                        >
                          View agent →
                        </Button>

                        {/* Response textarea */}
                        <Textarea
                          placeholder="Type your response..."
                          value={responses[request.id] || ''}
                          onChange={(e) =>
                            setResponses((prev) => ({
                              ...prev,
                              [request.id]: e.target.value,
                            }))
                          }
                          className="min-h-[80px]"
                        />

                        {/* Actions */}
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleRespond(request.id)}
                            disabled={loading || !responses[request.id]?.trim()}
                          >
                            Respond (⌘↵)
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleSkip(request.id)}
                            disabled={loading}
                          >
                            Skip (⌘S)
                          </Button>
                        </div>

                        {/* Timestamp */}
                        <p className="text-xs text-muted-foreground">
                          Asked{' '}
                          {new Date(request.created_at).toLocaleString()}
                        </p>
                      </div>
                    ))
                )}
              </div>
            </ScrollArea>
          </div>
        </>
      )}
    </div>
  );
}


