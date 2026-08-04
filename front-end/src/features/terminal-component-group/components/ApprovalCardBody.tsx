import { type RefObject } from 'react';
import type { RequestPaymentCardPayload } from '@/lib/realtime-types';

import { ApprovalPaymentReceipt } from './ApprovalPaymentReceipt';
import { MarkdownText } from './MarkdownText';

interface ApprovalScrollBodyProps {
  scrollerRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  onScroll: () => void;
  hasMoreBelow: boolean;
  pendingApproval: {
    imageUrl?: string | null;
    question: string;
    requestPaymentCard?: RequestPaymentCardPayload;
  };
}

/**
 * The single scroll region for the approval body. Kept IN FLOW (flex-1 +
 * min-h-0) so the height-capped card both fills and shrinks; an absolute or
 * `h-full` body either collapsed the card or never scrolled. The wrapper anchors
 * the bottom fade so it does not scroll away with the content. tabIndex + role
 * make the region keyboard-scrollable when the details overflow with no
 * focusable child — otherwise a user could not read the items they are paying for.
 */
export function ApprovalScrollBody({
  scrollerRef,
  contentRef,
  onScroll,
  hasMoreBelow,
  pendingApproval,
}: ApprovalScrollBodyProps) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        tabIndex={0}
        role="region"
        aria-label="Approval details"
        className="min-h-0 flex-1 overflow-y-auto"
      >
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
            <ApprovalPaymentReceipt receipt={pendingApproval.requestPaymentCard} />
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
  );
}
