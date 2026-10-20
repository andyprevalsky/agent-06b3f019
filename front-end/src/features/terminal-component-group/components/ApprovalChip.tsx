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
 * Typed context preserves its original bytes separately from the protocol response.
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
 * REQUESTER LABEL (Rose Desktop only): a request from a code agent
 * (`from_code_agent`) shows that agent's icon + name in the header.
 *
 * Props:
 * - pendingApproval: { attentionRequestId, question } | null
 * - onApprovalHandled: () => void
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import type { RequestPaymentCardPayload } from '@/lib/realtime-types';
import { respondToAttentionRequest, rejectAttentionRequest, useToast } from '../hooks';
import { ApprovalScrollBody } from './ApprovalCardBody';
import { codeAgentLabel, parseCodeAgentSender } from '../hooks/codeAgentContract';
import { ProviderIcon } from './claudeCodeChip.shared';

interface PendingApproval {
  attentionRequestId: string;
  question: string;
  imageUrl?: string | null;
  requestPaymentCard?: RequestPaymentCardPayload;
  fromCodeAgent?: unknown;
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
      await respondToAttentionRequest(
        pendingApproval.attentionRequestId,
        responseText,
        contextInput.trim() ? contextInput : undefined,
      );
      toast({ title: 'Approved', description: 'The agent will continue with the action' });
      setContextInput('');
      onApprovalHandled?.();
    } catch (error) {
      console.error('Failed to approve:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send approval',
        variant: 'destructive',
      });
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
        contextInput.trim() ? contextInput : undefined,
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

/**
 * Tracks whether a scroll container still has content below the fold, so the
 * card can show a "more below" affordance. Without it the capped body slices
 * whatever line it lands on and reads as a rendering bug rather than a scroll
 * region — which is exactly how the original cutoff was reported.
 */
function useHasMoreBelow(resetKey?: string) {
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

  // AgentChatArea keeps this component mounted for as long as SOME approval is
  // pending, so a second request reuses the first one's scroll position and
  // opens already scrolled past its own title — the exact cutoff this card
  // exists to prevent. Rewind and remeasure whenever the request identity
  // changes.
  // useLayoutEffect, not useEffect: a passive effect runs AFTER paint, so the
  // browser can present one frame of new content at the old scrollTop —
  // briefly recreating the very cutoff this hook prevents. Rewinding before
  // paint makes that frame unreachable.
  useLayoutEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    measure();
  }, [resetKey, measure]);

  return { scrollerRef, contentRef, hasMoreBelow, onScroll: measure };
}

function RequesterLabel({ fromCodeAgent }: { fromCodeAgent: unknown }) {
  const roseDesktop = useRoseDesktop();
  const sender = roseDesktop ? parseCodeAgentSender({ from_code_agent: fromCodeAgent }) : null;
  if (!sender) return null;
  const label = codeAgentLabel(sender.provider);
  return (
    <span
      data-testid="approval-requester"
      className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground dark:text-[#a3a39d]"
    >
      <ProviderIcon codeProvider={sender.provider} className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

export default function ApprovalChip({ pendingApproval, onApprovalHandled }: ApprovalChipProps) {
  const [contextInput, setContextInput] = useState('');
  const [actionState, setActionState] = useState<ActionState>(null);
  const { scrollerRef, contentRef, hasMoreBelow, onScroll } = useHasMoreBelow(
    pendingApproval?.attentionRequestId,
  );
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
            <RequesterLabel fromCodeAgent={pendingApproval.fromCodeAgent} />
          </div>
          <ApprovalScrollBody
            scrollerRef={scrollerRef}
            contentRef={contentRef}
            onScroll={onScroll}
            hasMoreBelow={hasMoreBelow}
            pendingApproval={pendingApproval}
          />
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
