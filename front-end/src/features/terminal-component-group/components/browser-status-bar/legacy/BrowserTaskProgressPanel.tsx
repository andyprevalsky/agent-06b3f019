/**
 * TaskProgressSidebar — the task-progress panel for the fullscreen browser
 * view: schema chip, optional step-progress bar, scrollable MessageList, and
 * an optional pending write-lock approval.
 *
 * Presentation is layout-driven:
 *   desktop -> fixed-width left column beside the iframe (border-r)
 *   mobile  -> full width below the aspect-matched live browser in the same
 *              fixed view, with this panel owning the remaining scroll space
 *
 * STATE MACHINE (presentation branch, driven by the isMobile/onClose props):
 * [DESKTOP]      -> fixed-width left column beside the iframe (no close button)
 * [MOBILE_STACKED] -> full-width panel always visible below the browser
 * [LEGACY_OVERLAY] -> optional close affordance only when parent supplies onClose
 */

import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MessageList } from '../../MessageList';
import { SchemaChip } from '../../SchemaChip';
import type { BrowserControlState } from '../../browserControlState';
import { BrowserWriteLockApproval } from '../BrowserWriteLockApproval';
import { StepProgressBar } from '../StepProgressBar';
import type { OutputSchemaRef, PendingWriteLockApproval, StepProgress } from '../types';

interface TaskProgressSidebarProps {
  taskId: string;
  outputSchema: OutputSchemaRef | undefined;
  stepProgress: StepProgress | null;
  controlState: BrowserControlState;
  pendingWriteLockApproval: PendingWriteLockApproval | null;
  isMobile?: boolean;
  onClose?: () => void;
}

export function TaskProgressSidebar({
  taskId,
  outputSchema,
  stepProgress,
  controlState,
  pendingWriteLockApproval,
  isMobile = false,
  onClose,
}: TaskProgressSidebarProps) {
  return (
    <div
      className={cn(
        'h-full bg-muted/10 flex flex-col overflow-hidden',
        isMobile
          ? 'w-full'
          : 'w-[min(320px,calc(100vw-60px))] border-r border-border flex-shrink-0',
      )}
      style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
    >
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Task progress
          </h4>
          <div className="flex items-center gap-2">
            <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="top" />
            {isMobile && onClose && (
              <button
                onClick={onClose}
                aria-label="Close task progress"
                className="p-1 rounded hover:bg-muted transition-colors"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>
        {stepProgress && (
          <div className="mt-1">
            <StepProgressBar progress={stepProgress} />
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-3">
        <div className="pb-[80vh]">
          <MessageList
            subAgentId={taskId}
            containerClassName="flex flex-col gap-1.5 overflow-x-hidden"
            showStatusBanners={false}
            showThinkingIndicator={controlState === 'active'}
            compact
          />
        </div>
      </div>
      {pendingWriteLockApproval && (
        <BrowserWriteLockApproval
          attentionRequestId={pendingWriteLockApproval.attentionRequestId}
          question={pendingWriteLockApproval.question}
        />
      )}
    </div>
  );
}
