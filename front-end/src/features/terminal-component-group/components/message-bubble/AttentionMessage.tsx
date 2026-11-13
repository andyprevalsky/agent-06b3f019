/**
 * Raw-text "send_message_to_user" bubble with optional streaming animation
 * and an "enter Autonomous Execution" affordance while the agent is waiting.
 *
 * STATE MACHINE:
 *   [STREAMING]  <-- isStreaming: the text so far as static markdown (tables, code)
 *                    every path keeps the reply's single line breaks (breaks)
 *      |
 *      | (stream ends)
 *      v
 *   [RENDERING]  <-- mount, MarkdownText animates in if shouldType && !hasAnimated
 *      |
 *      | (animation finishes)
 *      v
 *   [ANIMATED]   <-- hasAnimated=true, onComplete fired
 *
 * While isWaiting && !isStreaming:
 *   dashed yellow indicator + optional "Start Autonomous Execution" button.
 *
 * META LINE (settled messages with a sentAt, never while streaming): directly
 * under the text, "<send time> [copy on hover]" (MessageMeta.AgentMessageMeta),
 * the same record the user bubble carries, without a branch action.
 */
import { memo, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MarkdownText } from '../MarkdownText';
import { AutonomousExecutionIcon } from './AutonomousExecutionIcon';
import { AgentMessageMeta } from './MessageMeta';

interface AttentionMessageProps {
  attentionMessage: string;
  isWaiting: boolean;
  shouldType?: boolean;
  onComplete?: () => void;
  onStartExecution?: () => void | Promise<void>;
  isStreaming?: boolean;
  attentionRequestId?: string;
  onApprove?: (requestId: string) => Promise<void>;
  onDecline?: (requestId: string) => Promise<void>;
  /** ISO send time of the settled message; omitted for live streams and previews. */
  sentAt?: string;
}

type ActionState = 'approving' | 'declining' | 'done' | null;

function InlineApprovalActions({
  actionState,
  onApprove,
  onDecline,
}: {
  actionState: ActionState;
  onApprove: () => void;
  onDecline: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        onClick={onApprove}
        disabled={actionState !== null}
        className="h-8 bg-green-600 px-3 text-white hover:bg-green-700"
      >
        {actionState === 'approving' ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            <Check className="h-4 w-4" />
            Approve
          </>
        )}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onDecline}
        disabled={actionState !== null}
        className="h-8 border-red-500/30 px-3 text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30"
      >
        {actionState === 'declining' ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            <X className="h-4 w-4" />
            Decline
          </>
        )}
      </Button>
      {actionState === 'done' && <span className="text-xs text-muted-foreground">Sent</span>}
    </div>
  );
}

function WaitingIndicator(): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-amber-500">
      <div
        className="w-4 h-4 rounded-full border-2 border-dashed border-amber-500"
        style={{ animation: 'spin 3s linear infinite' }}
      />
      <span className="text-xs font-medium">
        Your Rose agent will continue working after your reply
      </span>
    </div>
  );
}

function AutonomousExecutionButton({
  onStartExecution,
}: {
  onStartExecution: () => void | Promise<void>;
}) {
  const [requestState, setRequestState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const handleStart = async () => {
    if (requestState !== 'idle') return;
    setRequestState('sending');
    setError(null);
    try {
      await onStartExecution();
      setRequestState('sent');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to send request');
      setRequestState('idle');
    }
  };
  return (
    <div className="space-y-2">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleStart()}
              disabled={requestState !== 'idle'}
              aria-busy={requestState === 'sending'}
              className="flex items-center gap-2 text-muted-foreground hover:bg-muted/30 hover:text-muted-foreground"
            >
              {requestState === 'sending' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <AutonomousExecutionIcon />
              )}
              {requestState === 'sending'
                ? 'Sending request…'
                : requestState === 'sent'
                  ? 'Request sent'
                  : 'Start Autonomous Execution'}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left text-xs">
            <p>
              Once Rose enters <strong>Autonomous Execution</strong> mode they will not ask you any
              more questions and will relentlessly explore all possible avenues in order to
              accomplish your goal given the context at its disposal.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export const AttentionMessage = memo(function AttentionMessage({
  attentionMessage,
  isWaiting,
  onComplete,
  onStartExecution,
  isStreaming = false,
  attentionRequestId,
  onApprove,
  onDecline,
  sentAt,
}: AttentionMessageProps) {
  const [hasAnimated, setHasAnimated] = useState(false);
  const [actionState, setActionState] = useState<ActionState>(null);

  const handleAnimationComplete = () => {
    setHasAnimated(true);
    if (onComplete) {
      requestAnimationFrame(() => {
        onComplete();
      });
    }
  };

  const handleAction = (kind: 'approving' | 'declining') => {
    if (attentionRequestId === undefined || actionState !== null) return;
    const run = kind === 'approving' ? onApprove : onDecline;
    if (run === undefined) return;
    setActionState(kind);
    run(attentionRequestId)
      .then(() => setActionState('done'))
      .catch(() => setActionState(null));
  };

  const showInlineApproval =
    isWaiting &&
    !isStreaming &&
    attentionRequestId !== undefined &&
    onApprove !== undefined &&
    onDecline !== undefined;

  return (
    <div className="group/message flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1 min-w-0 space-y-3">
        <div className="text-sm">
          <MarkdownText
            text={attentionMessage}
            breaks
            shouldAnimate={!isStreaming && isWaiting && !hasAnimated}
            onComplete={handleAnimationComplete}
          />
        </div>
        {sentAt !== undefined && !isStreaming && (
          <AgentMessageMeta text={attentionMessage} sentAt={sentAt} />
        )}

        {isWaiting && !isStreaming && (
          <>
            {showInlineApproval && (
              <InlineApprovalActions
                actionState={actionState}
                onApprove={() => handleAction('approving')}
                onDecline={() => handleAction('declining')}
              />
            )}
            <WaitingIndicator />

            {onStartExecution && <AutonomousExecutionButton onStartExecution={onStartExecution} />}
          </>
        )}
      </div>
    </div>
  );
});
