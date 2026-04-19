/**
 * STATE MACHINE: AgentSettingsDialog
 *
 * [CLOSED] <-- Dialog closed
 *     |
 *     v (open trigger)
 * [OPEN]
 *     |
 *     +--> [IDLE] <-- isDeleting: false
 *     |       |
 *     |       +--> (delete click)
 *     |       |       |
 *     |       |       v
 *     |       |   [CONFIRM_DELETE] <-- showDeleteSection: true, confirmEnabled: false
 *     |       |       |
 *     |       |       | (1.8s delay)
 *     |       |       v
 *     |       |   [CONFIRM_ENABLED] <-- confirmEnabled: true
 *     |       |       |
 *     |       |       +--> (confirm) --> [DELETING] <-- isDeleting: true
 *     |       |       +--> (cancel) --> [IDLE]
 *
 * Delete-flow state is owned by useDeleteFlow; price-limit editing state is
 * owned by usePriceLimitEdit; anchor position is owned by useModalPosition.
 */

import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Settings } from 'lucide-react';
import type { AgentSettingsDialogProps } from './agent-settings-dialog/types';
import MetricsSection from './agent-settings-dialog/MetricsSection';
import ResponseSchemaSection from './agent-settings-dialog/ResponseSchemaSection';
import DeleteSection from './agent-settings-dialog/DeleteSection';
import { useDeleteFlow } from './agent-settings-dialog/useDeleteFlow';
import { usePriceLimitEdit } from './agent-settings-dialog/usePriceLimitEdit';
import { useModalPosition } from './agent-settings-dialog/useModalPosition';

export default function AgentSettingsDialog({
  agent,
  onUpdate,
  onDelete,
}: AgentSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const modalPosition = useModalPosition(open, triggerRef);

  const deleteFlow = useDeleteFlow({
    agent,
    open,
    onDeleted: () => {
      setOpen(false);
      onDelete?.();
    },
  });

  const priceLimitEdit = usePriceLimitEdit({
    agent,
    onUpdated: () => onUpdate?.(),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen} modal={false}>
      <DialogTrigger asChild>
        <button
          ref={triggerRef}
          className="p-1.5 rounded-md hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </button>
      </DialogTrigger>
      <DialogContent
        className="p-0 border border-gray-300 dark:border-gray-700 shadow-lg [&>button]:hidden overflow-hidden"
        style={{
          position: 'fixed',
          bottom: `${modalPosition.bottom}px`,
          right: `${modalPosition.right}px`,
          top: 'auto',
          left: 'auto',
          transform: 'none',
          width: '420px',
          maxWidth: '90vw',
          maxHeight: '85vh',
          backgroundColor: 'transparent',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <div
          className="p-6 max-h-[85vh] overflow-y-auto"
          style={{ backgroundColor: 'transparent' }}
        >
          <DialogHeader className="mb-4">
            <DialogTitle>Agent Settings</DialogTitle>
          </DialogHeader>

          {!agent ? (
            <div className="py-8 text-center">
              <p className="text-muted-foreground">create an agent to view agent settings</p>
            </div>
          ) : (
            <div className="space-y-6">
              <MetricsSection agent={agent} priceLimitEdit={priceLimitEdit} />
              <ResponseSchemaSection agent={agent} />
              <DeleteSection flow={deleteFlow} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
