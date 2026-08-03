import { type RefObject } from 'react';
import type { RequestPaymentCardPayload } from '@/lib/realtime-types';

import { MarkdownText } from './MarkdownText';

function formatCents(cents = 0): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function PaymentReceipt({ receipt }: { receipt: RequestPaymentCardPayload }) {
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
  );
}
