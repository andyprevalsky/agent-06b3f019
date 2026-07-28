/**
 * STATE MACHINE: ApprovalChip
 *
 * VISIBILITY:
 * [HIDDEN] <-- no pending approval for selected agent
 *     |
 *     v (approval request detected via messages)
 * [VISIBLE] <-- replaces the query input with the approval chip
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
 * OVERFLOW STATES (useHasMoreBelow):
 * The card is height-capped (55dvh mobile / 70dvh desktop) so it can never
 * clip itself or bury the trajectory behind it. Its body is the only scroll
 * region; header, context input and Accept/Reject are pinned outside it.
 *
 * [FITS] <-- scrollHeight <= clientHeight; no affordance
 *     |
 *     | (content grows / user scrolls up)
 *     v
 * [MORE_BELOW] <-- hasMoreBelow: true; bottom fade rendered
 *     |
 *     v (user scrolls to end)
 * [FITS]
 * Re-measured on scroll and on ResizeObserver resize.
 *
 * Props:
 * - pendingApproval: { attentionRequestId, question } | null
 * - onApprovalHandled: () => void
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
              <div className="break-words">{item.name || 'Item'}</div>
              <div className="text-xs text-muted-foreground">
                Qty {item.quantity || 1} · {formatCents(item.unitPriceCents)}
              </div>
              {item.rating && item.reviewCount ? (
                <div className="text-xs text-muted-foreground">
                  Reviews: {item.rating} · {item.reviewCount}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">Review details unavailable</div>
              )}
              {item.productUrl ? (
                <a
                  href={item.productUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary underline-offset-2 hover:underline"
                >
                  View product
                </a>
              ) : (
                <div className="text-xs text-muted-foreground">Product link unavailable</div>
              )}
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

/**
 * Tracks whether a scroll container still has content below the fold, so the
 * card can show a "more below" affordance. Without it the capped body slices
 * whatever line it lands on and reads as a rendering bug rather than a scroll
 * region — which is exactly how the original cutoff was reported.
 */
function useHasMoreBelow() {
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const measure = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    setHasMoreBelow(node.scrollHeight - node.scrollTop - node.clientHeight > 1);
  }, []);

  // Observe BOTH boxes. The scroller's own border box never changes when its
  // content grows, so watching only it leaves the affordance permanently off
  // for exactly the long receipts that need it; the content box is what grows.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      measure();
      return;
    }
    const observer = new ResizeObserver(measure);
    for (const node of [scrollerRef.current, contentRef.current]) {
      if (node) observer.observe(node);
    }
    measure();
    return () => observer.disconnect();
  }, [measure]);

  return { scrollerRef, contentRef, hasMoreBelow, onScroll: measure };
}

export default function ApprovalChip({ pendingApproval, onApprovalHandled }: ApprovalChipProps) {
  const [contextInput, setContextInput] = useState('');
  const [actionState, setActionState] = useState<ActionState>(null);
  const { scrollerRef, contentRef, hasMoreBelow, onScroll } = useHasMoreBelow();
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
        {/*
         * The card owns a fixed height budget and scrolls its body internally.
         * Without that cap it is a shrinkable flex child of an `overflow-hidden`
         * column, so on a phone a receipt with several line items pushed the
         * title under the header and the Approve/Reject buttons off-screen —
         * an approval you could neither read nor action.
         *
         * The mobile cap is deliberately under half the viewport so the agent
         * trajectory behind the card stays readable while you decide; a purchase
         * approval you cannot cross-check against what the agent just did is
         * not a real approval. Desktop has room for more.
         */}
        <div className="flex max-h-[55dvh] flex-col rounded-xl border border-border bg-background/80 backdrop-blur-sm p-4 shadow-md md:max-h-[70dvh]">
          <div className="flex shrink-0 items-start justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              <span className="text-sm font-medium text-foreground">Approval Required</span>
            </div>
          </div>
          {/*
           * One scroll region for the whole body. A nested scroller on the
           * question alone (the old max-h-[300px]) let the browser park its
           * scrollTop past the first line, hiding "Approve a $X purchase from …"
           * — the single most important sentence on the card.
           */}
          {/*
           * The scroller must stay IN FLOW: the card is max-h-capped rather
           * than fixed-height, so it takes its height from its children. An
           * absolutely-positioned body contributes none and collapsed the card
           * to header+footer; an `h-full` body never resolved a percentage
           * against a flex item and so never scrolled at all. In-flow flex-1
           * with min-h-0 is the one arrangement that both fills and shrinks.
           * The wrapper exists purely to anchor the fade, which must not live
           * inside the scroller or it would scroll away with the content.
           */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div ref={scrollerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
              <div ref={contentRef}>
                {pendingApproval.imageUrl && (
                  <div className="mb-3 flex justify-center">
                    <img
                      src={pendingApproval.imageUrl}
                      alt="Request context"
                      className="max-w-[200px] max-h-[150px] rounded-md object-contain"
                    />
                  </div>
                )}
                <div className="mb-3 text-sm text-foreground">
                  <MarkdownText text={pendingApproval.question} breaks />
                </div>
                {pendingApproval.requestPaymentCard && (
                  <PaymentReceipt receipt={pendingApproval.requestPaymentCard} />
                )}
              </div>
            </div>
            {hasMoreBelow && (
              <div
                data-testid="approval-scroll-more"
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent"
              />
            )}
          </div>
          <div className="mb-3 shrink-0 pt-3">
            <Input
              placeholder="Add context (optional)..."
              value={contextInput}
              onChange={(e) => setContextInput(e.target.value)}
              className="text-sm bg-muted"
              disabled={actionState !== null}
            />
          </div>
          <div className="shrink-0">
            <ApprovalActions
              actionState={actionState}
              onAccept={() => void handleAccept()}
              onReject={() => void handleReject()}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
