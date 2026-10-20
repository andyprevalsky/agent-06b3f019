/**
 * STATE MACHINE: RemoveAccountDialog (Rose Desktop)
 *
 *   [CLOSED] (pending null) --chip ×--> [OPEN(label)] --Cancel / Esc--> [CLOSED]
 *   [OPEN] --Remove--> onConfirm → parent DELETE → [CLOSED]
 *   [OPEN + warning] (removal cannot be undone, e.g. agent-enrolled passkeys):
 *     the warning replaces "connect it again later"; same Cancel / Remove
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
          <DialogTitle>Remove account?</DialogTitle>
          {pending?.warning !== undefined ? (
            <DialogDescription data-testid="remove-account-warning">
              {pending.warning}
            </DialogDescription>
          ) : (
            <DialogDescription>
              {pending?.label} will be disconnected and Rose will stop syncing it. You can connect
              it again later.
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
