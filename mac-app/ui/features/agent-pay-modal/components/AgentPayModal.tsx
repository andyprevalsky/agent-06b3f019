import { Loader2 } from 'lucide-react';
import { useAgentPayModal } from '../hooks';
import type { AgentPayModalProps } from '../types';
import { ModalBody } from './ModalBody';
import { ModalFooter } from './ModalFooter';
import { ModalHeader } from './ModalHeader';

/**
 * Modal for configuring the user's agent-pay card + delivery address.
 *
 * State machine (mirrors the blackbox file header):
 *   closed --isOpen--> loading --GET 200--> [savedEnvelope ? saved-summary : card-form]
 *                                 --GET 4xx/5xx--> card-form (silent, logged)
 *   saved-summary --click "Update"--> card-form
 *   card-form --invalid submit--> card-form (with per-field errors)
 *   card-form --valid submit + PATCH 200--> onSuccess() called, modal closes
 *   card-form --valid submit + PATCH 4xx/5xx--> card-form with error banner
 *   any-open --click backdrop | Cancel | X--> onClose() (unless saving)
 *
 * This component is a pure renderer over `useAgentPayModal` — every piece
 * of state + every handler comes from the hook.
 */
const AgentPayModal = ({ isOpen, onClose, onSuccess }: AgentPayModalProps) => {
  const modal = useAgentPayModal(isOpen, onClose, onSuccess);
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={modal.handleClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden max-h-[90vh] flex flex-col">
        <ModalHeader saving={modal.saving} onClose={modal.handleClose} />
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
          {modal.initialLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ModalBody modal={modal} />
          )}
        </div>
        {!modal.initialLoading && (
          <ModalFooter
            saving={modal.saving}
            showCardForm={modal.showCardForm}
            onClose={modal.handleClose}
            onSave={() => void modal.handleSave()}
          />
        )}
      </div>
    </div>
  );
};

export default AgentPayModal;
