import { CostSummary } from './CostSummary';
import { LimitInput } from './LimitInput';
import { DeleteSection, IncreaseButton } from './ActionButtons';

interface CostLimitModalBodyProps {
  currentCostCents: number;
  currentLimitCents: number;
  newLimitInput: string;
  onLimitInputChange: (value: string) => void;
  isUpdating: boolean;
  isDeleting: boolean;
  showDeleteConfirm: boolean;
  confirmEnabled: boolean;
  onStartConfirm: () => void;
  onCancelConfirm: () => void;
  onConfirmDelete: () => void;
  onIncrease: () => void;
}

export function CostLimitModalBody({
  currentCostCents,
  currentLimitCents,
  newLimitInput,
  onLimitInputChange,
  isUpdating,
  isDeleting,
  showDeleteConfirm,
  confirmEnabled,
  onStartConfirm,
  onCancelConfirm,
  onConfirmDelete,
  onIncrease,
}: CostLimitModalBodyProps) {
  return (
    <div className="space-y-6 py-4">
      <CostSummary currentCostCents={currentCostCents} currentLimitCents={currentLimitCents} />
      <LimitInput
        value={newLimitInput}
        onChange={onLimitInputChange}
        disabled={isUpdating}
        currentCostCents={currentCostCents}
      />
      <div className="flex items-center gap-3">
        <DeleteSection
          showDeleteConfirm={showDeleteConfirm}
          confirmEnabled={confirmEnabled}
          isDeleting={isDeleting}
          isUpdating={isUpdating}
          onStartConfirm={onStartConfirm}
          onCancelConfirm={onCancelConfirm}
          onConfirmDelete={onConfirmDelete}
        />
        <div className="flex-1" />
        <IncreaseButton
          isUpdating={isUpdating}
          showDeleteConfirm={showDeleteConfirm}
          onIncrease={onIncrease}
        />
      </div>
    </div>
  );
}
