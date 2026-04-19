import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface DeleteSectionProps {
  showDeleteConfirm: boolean;
  confirmEnabled: boolean;
  isDeleting: boolean;
  isUpdating: boolean;
  onStartConfirm: () => void;
  onCancelConfirm: () => void;
  onConfirmDelete: () => void;
}

export function DeleteSection({
  showDeleteConfirm,
  confirmEnabled,
  isDeleting,
  isUpdating,
  onStartConfirm,
  onCancelConfirm,
  onConfirmDelete,
}: DeleteSectionProps) {
  if (!showDeleteConfirm) {
    return (
      <Button
        onClick={onStartConfirm}
        variant="outline"
        size="sm"
        className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-500/30"
        disabled={isUpdating}
      >
        <Trash2 className="h-4 w-4 mr-1" />
        Delete
      </Button>
    );
  }
  return (
    <div className="flex gap-2">
      <Button onClick={onCancelConfirm} variant="outline" size="sm" disabled={isDeleting}>
        Cancel
      </Button>
      <Button
        onClick={onConfirmDelete}
        disabled={isDeleting || !confirmEnabled}
        size="sm"
        className="bg-red-600 hover:bg-red-700 text-white"
      >
        {isDeleting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : confirmEnabled ? (
          'Confirm'
        ) : (
          'Wait...'
        )}
      </Button>
    </div>
  );
}

interface IncreaseButtonProps {
  isUpdating: boolean;
  showDeleteConfirm: boolean;
  onIncrease: () => void;
}

export function IncreaseButton({ isUpdating, showDeleteConfirm, onIncrease }: IncreaseButtonProps) {
  return (
    <Button
      onClick={onIncrease}
      disabled={isUpdating || showDeleteConfirm}
      className="bg-black hover:bg-black/90 text-white dark:bg-white dark:hover:bg-white/90 dark:text-black"
    >
      {isUpdating ? (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Updating...
        </>
      ) : (
        'Increase Limit'
      )}
    </Button>
  );
}
