/**
 * TaskProgressSidebar — the task-progress panel for an agent's live browser in
 * the Browser app drawer: schema chip, optional step-progress bar, scrollable
 * MessageList, and an optional pending write-lock approval.
 *
 * Layout: a left column beside the browser on desktop, below it on mobile,
 * owning its scroll space.
 *
 * STATE MACHINE (presentation branch, driven by the onClose prop):
 * [SIDE_OR_STACKED] -> always-visible trajectory beside or below the browser
 * [LEGACY_OVERLAY] -> optional close affordance only when parent supplies onClose
 */

import { X } from 'lucide-react';
import { MessageList } from '../MessageList';
import { SchemaChip } from '../SchemaChip';
import type { BrowserControlState } from '../browserControlState';
import { BrowserWriteLockApproval } from './BrowserWriteLockApproval';
import { StepProgressBar } from './StepProgressBar';
import type { OutputSchemaRef, PendingWriteLockApproval, StepProgress } from './types';

interface TaskProgressSidebarProps {
  taskId: string;
  outputSchema: OutputSchemaRef | undefined;
  stepProgress: StepProgress | null;
  controlState: BrowserControlState;
  pendingWriteLockApproval: PendingWriteLockApproval | null;
  onClose?: () => void;
}

export function TaskProgressSidebar({
  taskId,
  outputSchema,
  stepProgress,
  controlState,
  pendingWriteLockApproval,
  onClose,
}: TaskProgressSidebarProps) {
  return (
    <div
      data-testid="task-progress-panel"
      className="h-full w-full bg-muted/10 flex flex-col overflow-hidden"
      style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
    >
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Task progress
          </h4>
          <div className="flex items-center gap-2">
            <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="top" />
            {onClose && (
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
