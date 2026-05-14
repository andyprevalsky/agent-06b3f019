import { useCallback, useState } from 'react';
import { X, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { respondToAttentionRequest, rejectAttentionRequest, useToast } from '../../hooks';

interface BrowserWriteLockApprovalProps {
  attentionRequestId: string;
  question: string;
  onApprovalHandled?: () => void;
}

type ActionState = 'accepting' | 'rejecting' | null;

function useApprovalActions(
  attentionRequestId: string,
  onApprovalHandled: (() => void) | undefined,
) {
  const [actionState, setActionState] = useState<ActionState>(null);
  const { toast } = useToast();

  const runAction = useCallback(
    async (
      kind: Exclude<ActionState, null>,
      action: () => Promise<void>,
      successTitle: string,
      successDescription: string,
      failureDescription: string,
    ) => {
      try {
        setActionState(kind);
        await action();
        toast({ title: successTitle, description: successDescription });
        onApprovalHandled?.();
      } catch (error) {
        console.error(`Failed to ${kind.replace('ing', '')}:`, error);
        toast({ title: 'Error', description: failureDescription, variant: 'destructive' });
      } finally {
        setActionState(null);
      }
    },
    [onApprovalHandled, toast],
  );

  const handleAccept = useCallback(
    () =>
      runAction(
        'accepting',
        () => respondToAttentionRequest(attentionRequestId, 'Approved'),
        'Approved',
        'Write action approved',
        'Failed to approve action',
      ),
    [attentionRequestId, runAction],
  );

  const handleReject = useCallback(
    () =>
      runAction(
        'rejecting',
        () => rejectAttentionRequest(attentionRequestId),
        'Rejected',
        'Write action rejected',
        'Failed to reject action',
      ),
    [attentionRequestId, runAction],
  );

  return { actionState, handleAccept, handleReject };
}

function ApprovalActions({
  actionState,
  onAccept,
  onReject,
}: {
  actionState: ActionState;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onReject}
        disabled={actionState !== null}
        className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-500/30 hover:border-red-500/50"
      >
        {actionState === 'rejecting' ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <>
            <X className="w-3 h-3 mr-1" />
            Reject
          </>
        )}
      </Button>
      <Button
        size="sm"
        onClick={onAccept}
        disabled={actionState !== null}
        className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
      >
        {actionState === 'accepting' ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <>
            <Check className="w-3 h-3 mr-1" />
            Accept
          </>
        )}
      </Button>
    </div>
  );
}

export function BrowserWriteLockApproval({
  attentionRequestId,
  question,
  onApprovalHandled,
}: BrowserWriteLockApprovalProps) {
  const { actionState, handleAccept, handleReject } = useApprovalActions(
    attentionRequestId,
    onApprovalHandled,
  );

  return (
    <div className="px-3 py-3 border-x border-b border-border bg-amber-500/10 rounded-b-lg">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        <span className="text-xs font-medium text-foreground">Write Approval Required</span>
      </div>
      <p className="text-xs text-muted-foreground mb-3 line-clamp-2">{question}</p>
      <ApprovalActions
        actionState={actionState}
        onAccept={() => {
          void handleAccept();
        }}
        onReject={() => {
          void handleReject();
        }}
      />
    </div>
  );
}
