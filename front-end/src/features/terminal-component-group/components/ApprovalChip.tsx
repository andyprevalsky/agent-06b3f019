/**
 * STATE MACHINE: ApprovalChip
 *
 * VISIBILITY:
 * [HIDDEN] <-- no pending approval for selected agent
 *     |
 *     v (approval request detected via messages)
 * [VISIBLE] <-- shows approval chip above query input
 *     |
 *     v (accept/reject)
 * [HIDDEN]
 *
 * ACTION STATES:
 * [IDLE] <-- actionState: null
 *     |
 *     | (click Accept)
 *     v
 * [ACCEPTING] <-- actionState: 'accepting'
 *     |
 *     v (success/error)
 * [IDLE]
 *     |
 *     | (click Reject)
 *     v
 * [REJECTING] <-- actionState: 'rejecting'
 *     |
 *     v (success/error)
 * [IDLE]
 *
 * Props:
 * - pendingApproval: { attentionRequestId, question } | null
 * - onApprovalHandled: () => void
 */

import { useCallback, useState } from 'react';
import { X, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { RequestPaymentCardPayload } from '@/lib/realtime-types';
import { respondToAttentionRequest, rejectAttentionRequest, useToast } from '../hooks';
import { MarkdownText } from './MarkdownText';

interface PendingApproval {
  attentionRequestId: string;
  question: string;
  imageUrl?: string | null;
  requestPaymentCard?: RequestPaymentCardPayload;
}

interface ApprovalChipProps {
  pendingApproval: PendingApproval | null;
  onApprovalHandled?: () => void;
}

type ActionState = 'accepting' | 'rejecting' | null;

interface UseApprovalHandlersArgs {
  pendingApproval: PendingApproval | null;
  contextInput: string;
  setContextInput: (v: string) => void;
  setActionState: (s: ActionState) => void;
  onApprovalHandled?: () => void;
}

function useApprovalHandlers({
  pendingApproval,
  contextInput,
  setContextInput,
  setActionState,
  onApprovalHandled,
}: UseApprovalHandlersArgs) {
  const { toast } = useToast();

  const handleAccept = useCallback(async () => {
    if (!pendingApproval) return;
    try {
      setActionState('accepting');
      const responseText = contextInput.trim() || 'Approved';
      await respondToAttentionRequest(pendingApproval.attentionRequestId, responseText);
      toast({ title: 'Approved', description: 'The agent will continue with the action' });
      setContextInput('');
      onApprovalHandled?.();
    } catch (error) {
      console.error('Failed to approve:', error);
      toast({ title: 'Error', description: 'Failed to send approval', variant: 'destructive' });
    } finally {
      setActionState(null);
    }
  }, [pendingApproval, contextInput, setActionState, setContextInput, onApprovalHandled, toast]);

  const handleReject = useCallback(async () => {
    if (!pendingApproval) return;
    try {
      setActionState('rejecting');
      await rejectAttentionRequest(
        pendingApproval.attentionRequestId,
        contextInput.trim() || undefined,
      );
      toast({ title: 'Rejected', description: 'The agent will skip this action and continue' });
      setContextInput('');
      onApprovalHandled?.();
    } catch (error) {
      console.error('Failed to reject:', error);
      toast({ title: 'Error', description: 'Failed to reject action', variant: 'destructive' });
    } finally {
      setActionState(null);
    }
  }, [pendingApproval, contextInput, setActionState, setContextInput, onApprovalHandled, toast]);

  return { handleAccept, handleReject };
}

interface ApprovalActionsProps {
  actionState: ActionState;
  onAccept: () => void;
  onReject: () => void;
}

function ApprovalActions({ actionState, onAccept, onReject }: ApprovalActionsProps) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onReject}
        disabled={actionState !== null}
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
        disabled={actionState !== null}
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

function formatCents(cents = 0): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function PaymentReceipt({
  receipt,
}: {
  receipt: NonNullable<PendingApproval['requestPaymentCard']>;
}) {
  return (
    <div className="mb-3 rounded-lg border bg-muted/40 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium">{receipt.merchant || 'Merchant'}</span>
        <span className="font-semibold">{formatCents(receipt.totalCents)}</span>
      </div>
      <div className="space-y-2">
        {(receipt.lineItems || []).map((item, index) => (
          <div key={`${item.name || 'item'}-${index}`} className="flex items-center gap-3">
            {item.imageUrl && (
              <img src={item.imageUrl} alt="" className="h-10 w-10 rounded object-cover" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate">{item.name || 'Item'}</div>
              <div className="text-xs text-muted-foreground">
                Qty {item.quantity || 1} · {formatCents(item.unitPriceCents)}
              </div>
            </div>
            <div className="font-medium">{formatCents(item.lineTotalCents)}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-1 border-t pt-2">
        <div className="flex justify-between text-muted-foreground">
          <span>Subtotal</span>
          <span>{formatCents(receipt.subtotalCents)}</span>
        </div>
        {(receipt.fees || []).map((fee, index) => (
          <div
            key={`${fee.label || 'fee'}-${index}`}
            className="flex justify-between text-muted-foreground"
          >
            <span>{fee.label || 'Fee'}</span>
            <span>{formatCents(fee.amountCents)}</span>
          </div>
        ))}
        <div className="flex justify-between font-semibold">
          <span>Total</span>
          <span>{formatCents(receipt.totalCents)}</span>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Rose will charge your saved Stripe billing method, then issue a one-time virtual card.
      </p>
    </div>
  );
}

export default function ApprovalChip({ pendingApproval, onApprovalHandled }: ApprovalChipProps) {
  const [contextInput, setContextInput] = useState('');
  const [actionState, setActionState] = useState<ActionState>(null);
  const { handleAccept, handleReject } = useApprovalHandlers({
    pendingApproval,
    contextInput,
    setContextInput,
    setActionState,
    onApprovalHandled,
  });

  if (!pendingApproval) return null;

  return (
    <div className="w-full mb-3">
      <div className="max-w-4xl mx-auto">
        <div className="rounded-xl border border-border bg-background/80 backdrop-blur-sm p-4 shadow-md">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              <span className="text-sm font-medium text-foreground">Approval Required</span>
            </div>
          </div>
          {pendingApproval.imageUrl && (
            <div className="mb-3 flex justify-center">
              <img
                src={pendingApproval.imageUrl}
                alt="Request context"
                className="max-w-[200px] max-h-[150px] rounded-md object-contain"
              />
            </div>
          )}
          <div className="mb-3 text-sm text-foreground max-h-[300px] overflow-y-auto">
            <MarkdownText text={pendingApproval.question} breaks />
          </div>
          {pendingApproval.requestPaymentCard && (
            <PaymentReceipt receipt={pendingApproval.requestPaymentCard} />
          )}
          <div className="mb-3">
            <Input
              placeholder="Add context (optional)..."
              value={contextInput}
              onChange={(e) => setContextInput(e.target.value)}
              className="text-sm bg-muted"
              disabled={actionState !== null}
            />
          </div>
          <ApprovalActions
            actionState={actionState}
            onAccept={() => void handleAccept()}
            onReject={() => void handleReject()}
          />
        </div>
      </div>
    </div>
  );
}
