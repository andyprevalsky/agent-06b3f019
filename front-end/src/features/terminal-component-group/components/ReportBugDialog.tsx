/**
 * STATE MACHINE: ReportBugDialog (admin-only; its own control, outside Agent Settings)
 *
 *   [HIDDEN] <-- non-admin account or no agent (renders nothing)
 *
 *   [CLOSED] --click bug icon--> [COMPOSING] (composer opens straight away)
 *   [COMPOSING] --Cancel | Esc | outside click (only while the draft is empty)-->
 *               [CLOSED] (draft discarded)
 *   [COMPOSING] --Submit--> [SUBMITTING] --ok--> [LAUNCHED] (Open/Copy explicit)
 *                                        --err--> [COMPOSING] (draft kept)
 *   [LAUNCHED] --Done | click outside | Esc--> [CLOSED]
 *
 * Flow state is owned by useReportBug (reset on close and agent switch);
 * anchor position by useModalPosition, same glass panel as Agent Settings.
 *
 * Trigger: variant 'nub' (Rose Desktop query-box tab) = bare white bug with
 * the instant "Report bug" tooltip; variant 'icon' (stock TopBar) = muted bug
 * beside the settings gear.
 */

import { useRef, useState } from 'react';
import { Bug } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { isAdminOperator } from '@/lib/adminAccounts';
import { useAuth, type AgentDetail } from '../hooks';
import ReportBugSection from './agent-settings-dialog/ReportBugSection';
import { useModalPosition } from './agent-settings-dialog/useModalPosition';
import { useReportBug } from './agent-settings-dialog/useReportBug';
import { NUB_ITEM_CLASS, NubTip } from './query-input/NubTip';

interface ReportBugDialogProps {
  agent: AgentDetail | null;
  variant?: 'icon' | 'nub';
}

export default function ReportBugDialog({ agent, variant = 'icon' }: ReportBugDialogProps) {
  const { user } = useAuth();
  if (!agent || !isAdminOperator(user)) return null;
  return <ReportBugPanel agent={agent} nub={variant === 'nub'} />;
}

function ReportBugPanel({ agent, nub }: { agent: AgentDetail; nub: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const modalPosition = useModalPosition(open, triggerRef, nub ? 'start' : 'end');
  const flow = useReportBug({ agent, open });
  const close = () => setOpen(false);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) flow.start();
  };

  const trigger = (
    <DialogTrigger asChild>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Report bug"
        data-testid="report-bug-trigger"
        data-nub-item={nub ? '' : undefined}
        className={
          nub
            ? NUB_ITEM_CLASS
            : 'p-1.5 rounded-md hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground'
        }
      >
        <Bug className="h-4 w-4" strokeWidth={nub ? 2.2 : 2} />
      </button>
    </DialogTrigger>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      {nub ? <NubTip label="Report bug">{trigger}</NubTip> : trigger}
      <DialogContent
        data-testid="report-bug-dialog"
        // A typed draft survives clicks elsewhere (e.g. copying from the chat);
        // Cancel, Esc or the trigger still close it.
        onInteractOutside={(event) => {
          if (flow.description.trim() !== '' || flow.attachments.length > 0 || flow.isSubmitting) {
            event.preventDefault();
          }
        }}
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
            <DialogTitle>Report bug</DialogTitle>
          </DialogHeader>
          <ReportBugSection flow={{ ...flow, cancel: close, dismissLaunched: close }} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
