/**
 * BrowserWriteLockApproval — renders an inline approve/reject dialog at the
 * bottom of the BrowserStatusBar's actions panel when a pending write-permission
 * attention request is detected.
 *
 * STATE MACHINE:
 *   [IDLE] --> actionState: null
 *       |   (click Accept) --> calls respondToAttentionRequest
 *       v
 *   [ACCEPTING] --> actionState: 'accepting'
 *       |   (success)                      (failure)
 *       v                                       v
 *   [IDLE] (onApprovalHandled)           [IDLE] (toast error)
 *
 *   [IDLE] --(click Reject)--> [REJECTING] --> [IDLE]
 *   typed context --> raw authored bytes; empty input --> protocol-only action
 */

import { useCallback, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { respondToAttentionRequest, rejectAttentionRequest, useToast } from '../../hooks';

interface BrowserWriteLockApprovalProps {
  attentionRequestId: string;
  question: string;
  onApprovalHandled?: () => void;
}

type ActionState = 'accepting' | 'rejecting' | null;

function ApprovalButtons({
  actionState,
  disabled,
  onAccept,
  onReject,
}: {
  actionState: ActionState;
  disabled: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onReject}
        disabled={disabled}
        className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-500/30 hover:border-red-500/50 transition-colors"
      >
        {actionState === 'rejecting' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            <X className="w-4 h-4 mr-1" />
            Reject
          </>
        )}
      </Button>
      <Button
        size="sm"
        onClick={onAccept}
        disabled={disabled}
        className="bg-green-600 hover:bg-green-700 text-white"
      >
        {actionState === 'accepting' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            <Check className="w-4 h-4 mr-1" />
            Accept
          </>
        )}
      </Button>
    </div>
  );
}

function useApprovalActions(
  attentionRequestId: string,
  contextInput: string,
  resetInput: () => void,
  onApprovalHandled: (() => void) | undefined,
) {
  const [actionState, setActionState] = useState<ActionState>(null);
  const { toast } = useToast();

  const handleAccept = useCallback(async () => {
    try {
      setActionState('accepting');
      const responseText = contextInput.trim() || 'Approved';
      await respondToAttentionRequest(
        attentionRequestId,
        responseText,
        contextInput.trim() ? contextInput : undefined,
      );
      toast({ title: 'Approved', description: 'Write action approved' });
      resetInput();
      onApprovalHandled?.();
    } catch (error) {
      console.error('Failed to accept:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to approve action',
        variant: 'destructive',
      });
    } finally {
      setActionState(null);
    }
  }, [attentionRequestId, contextInput, onApprovalHandled, resetInput, toast]);

  const handleReject = useCallback(async () => {
    try {
      setActionState('rejecting');
      await rejectAttentionRequest(
        attentionRequestId,
        contextInput.trim() ? contextInput : undefined,
      );
      toast({ title: 'Rejected', description: 'Write action rejected' });
      resetInput();
      onApprovalHandled?.();
    } catch (error) {
      console.error('Failed to reject:', error);
      toast({ title: 'Error', description: 'Failed to reject action', variant: 'destructive' });
    } finally {
      setActionState(null);
    }
  }, [attentionRequestId, contextInput, onApprovalHandled, resetInput, toast]);

  const onAccept = useCallback(() => {
    void handleAccept();
  }, [handleAccept]);

  const onReject = useCallback(() => {
    void handleReject();
  }, [handleReject]);

  return { actionState, onAccept, onReject };
}

export function BrowserWriteLockApproval({
  attentionRequestId,
  question,
  onApprovalHandled,
}: BrowserWriteLockApprovalProps) {
  const [contextInput, setContextInput] = useState('');
  const resetInput = useCallback(() => setContextInput(''), []);
  const { actionState, onAccept, onReject } = useApprovalActions(
    attentionRequestId,
    contextInput,
    resetInput,
    onApprovalHandled,
  );
  const disabled = actionState !== null;

  return (
    <div className="p-3">
      <div className="rounded-xl border border-border bg-background/80 backdrop-blur-sm p-4 shadow-md">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-sm font-medium text-foreground">Approval Required</span>
        </div>
        <div className="mb-3 text-sm text-foreground">{question}</div>
        <div className="mb-3">
          <Input
            placeholder="Add context (optional)..."
            value={contextInput}
            onChange={(e) => setContextInput(e.target.value)}
            className="bg-muted"
            disabled={disabled}
          />
        </div>
        <ApprovalButtons
          actionState={actionState}
          disabled={disabled}
          onAccept={onAccept}
          onReject={onReject}
        />
      </div>
    </div>
  );
}
