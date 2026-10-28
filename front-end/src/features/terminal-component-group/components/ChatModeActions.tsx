/**
 * STATE MACHINE: ChatModeActions
 *
 * VISIBILITY:
 *   Shown only when:
 *   - in chat mode
 *   - subAgentId is undefined (main chat)
 *   - last filtered message is send_message_to_user (FINISHED TOOL)
 *   - no streaming / no animating
 *   - agent status is ACTIVE
 *
 * ACTIONS:
 *   [IDLE] --(copy click)--> copyToClipboard(lastAssistantText) --> toast "Copied"
 *   [IDLE] --(start agent)--> [STARTING] startAgent(selectedAgentId)
 *            disabled "Starting agent…" at once; repeat clicks ignored (one POST)
 *   [STARTING] --resolve--> toast "Agent mode started"; stays [STARTING] until
 *                           chat mode ends and unmounts this: AGENT_MODE_STARTED,
 *                           or the detail snapshot read right after the POST
 *                           (a lost realtime frame cannot strand the button)
 *   [STARTING] --reject--> [IDLE] + toast destructive
 */
import { useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { fetchAgentDetail, startAgent, useAgentContext, useToast, type Message } from '../hooks';
import { copyToClipboard } from '@/lib/clipboard';

interface ChatModeActionsProps {
  filteredMessages: Message[];
  selectedAgentId: string | null;
}

function findCopyableText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'ASSISTANT') return m.text;
    if (m.role === 'TOOL' && m.metadata?.toolStatus === 'FINISHED' && m.text) return m.text;
  }
  return undefined;
}

export function ChatModeActions({ filteredMessages, selectedAgentId }: ChatModeActionsProps) {
  const { toast } = useToast();
  const { applyAgentDetail } = useAgentContext();
  // Starting a workflow takes a Temporal round trip; acknowledge the click now.
  const [isStarting, setIsStarting] = useState(false);
  const startingRef = useRef(false);

  const handleCopy = () => {
    const text = findCopyableText(filteredMessages);
    if (!text) return;
    copyToClipboard(text)
      .then(() => toast({ title: 'Copied to clipboard' }))
      .catch((error: unknown) => {
        console.error('Failed to copy to clipboard:', error);
      });
  };

  const handleStartAgent = () => {
    if (!selectedAgentId || startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);
    const agentId = selectedAgentId;
    startAgent(agentId)
      .then(() => {
        toast({ title: 'Agent mode started' });
        fetchAgentDetail(agentId)
          .then((detail) => applyAgentDetail(agentId, detail))
          .catch((error: unknown) => console.error('Failed to refresh started agent:', error));
      })
      .catch((error: unknown) => {
        startingRef.current = false;
        setIsStarting(false);
        toast({
          title: 'Failed to start agent',
          description: error instanceof Error ? error.message : 'Unknown error',
          variant: 'destructive',
        });
      });
  };

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex items-center gap-3 text-muted-foreground">
        <button
          onClick={handleCopy}
          className="p-1.5 hover:bg-muted/50 rounded transition-colors"
          title="Copy response"
        >
          <Copy className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-border" />
        <button
          onClick={handleStartAgent}
          disabled={isStarting}
          aria-busy={isStarting}
          className="flex items-center gap-2 px-2 py-1 hover:bg-muted/50 rounded transition-colors text-sm disabled:opacity-60 disabled:hover:bg-transparent"
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="1" />
            <path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z" />
            <path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z" />
          </svg>
          {isStarting ? 'Starting agent…' : 'Start agent'}
        </button>
      </div>
    </div>
  );
}

export default ChatModeActions;
