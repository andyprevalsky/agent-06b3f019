import { Pencil } from 'lucide-react';
import type { EncryptedPaymentEnvelope } from '@/lib/encryption';
import { CardIcons } from './CardIcons';

interface SavedCardSummaryProps {
  envelope: EncryptedPaymentEnvelope;
  onEdit: () => void;
}

/**
 * Masked last-4 summary shown when the user has a saved envelope and has
 * not clicked "Update" to re-edit the card. The "Update" button flips the
 * parent into edit mode (hook.setEditingCard(true)) revealing the full card
 * form.
 */
export const SavedCardSummary = ({ envelope, onEdit }: SavedCardSummaryProps) => (
  <div className="p-4 border rounded-lg bg-muted/30 space-y-3">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        {CardIcons[envelope.card_type] ?? CardIcons.unknown}
        <div>
          <p className="text-sm font-medium text-foreground">
            **** **** **** {envelope.card_last_four}
          </p>
          <p className="text-xs text-muted-foreground">
            {envelope.billing_city}, {envelope.billing_country}
          </p>
        </div>
      </div>
      <button
        onClick={onEdit}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
      >
        <Pencil className="w-3 h-3" />
        Update
      </button>
    </div>
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Autopay limit:</span>
      <span className="font-medium text-foreground">
        ${(envelope.autoagentpaylimit_cents / 100).toFixed(2)}
      </span>
    </div>
  </div>
);
