import { CreditCard, X } from 'lucide-react';

interface ModalHeaderProps {
  saving: boolean;
  onClose: () => void;
}

/**
 * Top bar with title + close (X) button. The close button is disabled while
 * a save is in flight — the backdrop click is also no-op'd by the hook
 * layer so all three close affordances behave identically under saving.
 */
export const ModalHeader = ({ saving, onClose }: ModalHeaderProps) => (
  <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
    <div className="flex items-center gap-2">
      <CreditCard className="w-4 h-4 text-muted-foreground" />
      <h2 className="text-base font-semibold text-foreground">Agent Pay</h2>
    </div>
    <button
      onClick={onClose}
      disabled={saving}
      className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
    >
      <X className="w-4 h-4" />
    </button>
  </div>
);
