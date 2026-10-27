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
 *     |
 *     +--> [REPORT_BUG] <-- admin only; composer open for bug description
 *             |
 *             +--> (submit) --> boxes.dev Bug Report run titled from description
 *             |                 (no SMS, no auto-open; Open/Copy stay explicit)
 *             +--> (cancel) --> [IDLE]
 *
 * Delete-flow state is owned by useDeleteFlow; price-limit editing state is
 * owned by usePriceLimitEdit; report-bug state is owned by useReportBug;
 * anchor position is owned by useModalPosition (clamped inside the viewport,
 * height capped below the mobile header, re-fit on rotation). Phones (< md)
 * get an opaque panel; the desktop panel stays transparent glass.
 *
 * Trigger: variant 'icon' (stock) = muted gear; variant 'nub' (Rose Desktop
 * query-box tab) = bare white gear with the instant "Agent settings" tooltip.
 *
 * Anchor (above the trigger, opening away from its side of the screen):
 *   'icon' sits at the right end of the stock TopBar -> right edges align,
 *          the panel extends leftward
 *   'nub'  sits on the tab at the query box's left edge -> left edges align,
 *          the panel extends rightward
 *   either way the panel stays inside an 8px viewport gutter
 */

import { useRef, useState, type RefObject } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Settings } from 'lucide-react';
import { isAdminOperator } from '@/lib/adminAccounts';
import { useAuth } from '../hooks';
import type { AgentSettingsDialogProps } from './agent-settings-dialog/types';
import MetricsSection from './agent-settings-dialog/MetricsSection';
import ResponseSchemaSection from './agent-settings-dialog/ResponseSchemaSection';
import DeleteSection from './agent-settings-dialog/DeleteSection';
import ReportBugSection from './agent-settings-dialog/ReportBugSection';
import { useDeleteFlow } from './agent-settings-dialog/useDeleteFlow';
import { usePriceLimitEdit } from './agent-settings-dialog/usePriceLimitEdit';
import { useModalPosition } from './agent-settings-dialog/useModalPosition';
import { useReportBug } from './agent-settings-dialog/useReportBug';
import { NUB_ITEM_CLASS, NubTip } from './query-input/NubTip';

/** Stock muted gear, or the bare white nub gear with its instant tooltip. */
function SettingsTrigger({
  nub,
  triggerRef,
}: {
  nub: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const trigger = (
    <DialogTrigger asChild>
      <button
        ref={triggerRef}
        aria-label={nub ? 'Agent settings' : undefined}
        data-nub-item={nub ? '' : undefined}
        className={
          nub
            ? NUB_ITEM_CLASS
            : 'p-1.5 rounded-md hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground'
        }
      >
        <Settings className="h-4 w-4" strokeWidth={nub ? 2.2 : 2} />
      </button>
    </DialogTrigger>
  );
  return nub ? <NubTip label="Agent settings">{trigger}</NubTip> : trigger;
}

export default function AgentSettingsDialog({
  agent,
  onUpdate,
  onDelete,
  variant = 'icon',
}: AgentSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const modalPosition = useModalPosition(open, triggerRef, variant === 'nub' ? 'start' : 'end');
  const { user: authUser } = useAuth();
  const showReportBug = isAdminOperator(authUser);

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

  const reportBug = useReportBug({ agent, open });

  return (
    <Dialog open={open} onOpenChange={setOpen} modal={false}>
      <SettingsTrigger nub={variant === 'nub'} triggerRef={triggerRef} />
      <DialogContent
        className="p-0 border border-gray-300 dark:border-white/[0.09] shadow-lg [&>button]:hidden overflow-hidden bg-[#EEEFF2] dark:bg-[#262624] md:bg-transparent md:dark:bg-transparent"
        style={{
          position: 'fixed',
          bottom: modalPosition.bottom,
          left: modalPosition.left,
          right: modalPosition.right,
          top: 'auto',
          transform: 'none',
          width: modalPosition.width,
          maxHeight: modalPosition.maxHeight,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <div className="p-6 overflow-y-auto" style={{ maxHeight: modalPosition.maxHeight }}>
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
              {showReportBug ? <ReportBugSection flow={reportBug} /> : null}
              <DeleteSection flow={deleteFlow} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
