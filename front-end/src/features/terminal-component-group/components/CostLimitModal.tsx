/**
 * STATE MACHINE: CostLimitModal
 *
 * [CLOSED] <-- Dialog closed
 *     |
 *     v (status=COST_LIMIT_REACHED)
 * [OPEN]
 *     |
 *     +--> [IDLE] <-- showDeleteConfirm: false
 *     |       |
 *     |       +--> (increase click) --> [UPDATING] <-- isUpdating: true
 *     |       |       |
 *     |       |       +--> (success) --> [CLOSED] + resume
 *     |       |       +--> (error) --> [IDLE]
 *     |       |
 *     |       +--> (delete click)
 *     |               |
 *     |               v
 *     |       [DELETE_CONFIRM] <-- showDeleteConfirm: true, confirmEnabled: false
 *     |               |
 *     |               | (1.8s delay)
 *     |               v
 *     |       [CONFIRM_ENABLED] <-- confirmEnabled: true
 *     |               |
 *     |               +--> (confirm) --> [DELETING] <-- isDeleting: true --> [CLOSED]
 *     |               +--> (cancel) --> [IDLE]
 *     |
 *     +--> (close) --> [CLOSED]
 *
 * Increase + delete state/flows live in useIncreaseLimit + useDeleteFlow.
 * Rendering is split into CostSummary, LimitInput, DeleteSection, IncreaseButton
 * and aggregated by CostLimitModalBody.
 */

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatCentsAsDollars } from './costLimitModal/format';
import { useIncreaseLimit } from './costLimitModal/useIncreaseLimit';
import { useDeleteFlow } from './costLimitModal/useDeleteFlow';
import { CostLimitModalBody } from './costLimitModal/CostLimitModalBody';

interface CostLimitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  currentLimitCents: number;
  currentCostCents: number;
  onIncrease?: () => void;
  onDelete?: () => void;
}

export default function CostLimitModal({
  open,
  onOpenChange,
  agentId,
  currentLimitCents,
  currentCostCents,
  onIncrease,
  onDelete,
}: CostLimitModalProps) {
  const [newLimitInput, setNewLimitInput] = useState('');

  useEffect(() => {
    if (open) setNewLimitInput(formatCentsAsDollars(currentLimitCents + 50));
  }, [open, currentLimitCents]);

  const { isUpdating, increase } = useIncreaseLimit({
    agentId,
    currentCostCents,
    onSuccess: () => {
      onOpenChange(false);
      onIncrease?.();
    },
  });

  const deleteFlow = useDeleteFlow({
    agentId,
    open,
    onSuccess: () => {
      onOpenChange(false);
      onDelete?.();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent
        className="sm:max-w-md p-0 border border-gray-300 dark:border-white/[0.09] shadow-lg [&>button]:hidden overflow-hidden"
        style={{
          backgroundColor: 'transparent',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <div className="p-6" style={{ backgroundColor: 'transparent' }}>
          <DialogHeader>
            <DialogTitle className="text-foreground">
              This Task Has Crossed the Price Limit Set
            </DialogTitle>
          </DialogHeader>
          <CostLimitModalBody
            currentCostCents={currentCostCents}
            currentLimitCents={currentLimitCents}
            newLimitInput={newLimitInput}
            onLimitInputChange={setNewLimitInput}
            isUpdating={isUpdating}
            isDeleting={deleteFlow.isDeleting}
            showDeleteConfirm={deleteFlow.showDeleteConfirm}
            confirmEnabled={deleteFlow.confirmEnabled}
            onStartConfirm={deleteFlow.startConfirm}
            onCancelConfirm={deleteFlow.cancelConfirm}
            onConfirmDelete={() => void deleteFlow.confirmDelete()}
            onIncrease={() => void increase(newLimitInput)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
