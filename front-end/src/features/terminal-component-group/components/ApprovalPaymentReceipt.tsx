/**
 * STATE FLOW
 *
 *   structured payment receipt
 *       -> render merchant + total
 *       -> render zero or more line items
 *            (rating and review count are optional; the reviews line shows whichever is present)
 *       -> render zero or more fees
 *       -> render saved-card charge disclosure
 *
 * This component is presentational: its only state is the immutable receipt
 * supplied by the approval card.
 */
import type { RequestPaymentCardPayload } from '@/lib/realtime-types';

function formatCents(cents = 0): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function reviewsLabel(rating?: string, reviewCount?: string): string | null {
  const parts = [rating, reviewCount].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? `Reviews: ${parts.join(' · ')}` : null;
}

export function ApprovalPaymentReceipt({ receipt }: { receipt: RequestPaymentCardPayload }) {
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
              <div className="text-xs text-muted-foreground">
                {reviewsLabel(item.rating, item.reviewCount) ?? 'Review details unavailable'}
              </div>
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
