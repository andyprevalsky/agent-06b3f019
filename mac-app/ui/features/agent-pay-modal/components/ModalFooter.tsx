/**
 * STATE MACHINE: AgentPayModal Footer
 *
 * [READY] -- save clicked --> [SAVING]
 * [SAVING] -- success --> [READY_OR_CLOSED]
 * [SAVING] -- failure --> [READY]
 * [READY] -- cancel clicked --> [CLOSED]
 *
 * The primary action saves the autopay limit settings; it no longer submits
 * saved card details.
 */

import { Loader2 } from 'lucide-react';

interface ModalFooterProps {
  saving: boolean;
  showCardForm: boolean;
  onClose: () => void;
  onSave: () => void;
}

/**
 * Bottom action row: Cancel + Save buttons.
 */
export const ModalFooter = ({ saving, showCardForm, onClose, onSave }: ModalFooterProps) => {
  const savingLabel = 'Saving...';
  const idleLabel = 'Save Autopay Limit';
  return (
    <div className="flex justify-end gap-2 px-5 py-4 border-t border-border bg-muted/30 shrink-0">
      <button
        onClick={onClose}
        disabled={saving}
        className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={saving}
        className="px-4 py-2 text-sm font-medium bg-foreground text-background rounded-lg hover:bg-foreground/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
      >
        {saving ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            {savingLabel}
          </>
        ) : (
          idleLabel
        )}
      </button>
    </div>
  );
};
