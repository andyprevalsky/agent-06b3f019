/**
 * STATE MACHINE: RemoveAccountDialog (Rose Desktop)
 *
 *   [CLOSED] (pending null) --chip ×--> [OPEN(label)] --Cancel / Esc--> [CLOSED]
 *   [OPEN] --Disconnect--> onConfirm → parent DELETE → [CLOSED]
 *
 * Pure presentation over hooks/useIntegrationRemoval.
 */

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import type { PendingRemoval } from '../hooks/useIntegrationRemoval';

export default function RemoveAccountDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingRemoval | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Disconnect?</DialogTitle>
          <DialogDescription>
            {pending?.label} will be disconnected and Rose will stop syncing it. You can connect it
            again later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
