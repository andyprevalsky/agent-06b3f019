import { cn } from '@/lib/utils';
import type { Message } from '../../hooks';
import { BrowserControls } from './BrowserControls';
import { BrowserIframe } from './BrowserIframe';
import { BrowserWriteLockApproval } from './BrowserWriteLockApproval';
import { FullscreenActionsPanel } from './ActionsPanel';
import type { PendingWriteLockApproval } from './hooks';

interface BrowserViewBodyProps {
  containerRef: React.RefObject<HTMLDivElement>;
  taskId: string;
  messages: Message[];
  currentBrowserUrl: string;
  isThisFullscreen: boolean;
  isDisconnected: boolean;
  isResuming: boolean;
  pendingWriteLockApproval: PendingWriteLockApproval | null;
  onToggleFullscreen: () => void;
  onResume: () => void;
  onApprovalHandled?: () => void;
}

function ControlHint({ isFullscreen }: { isFullscreen: boolean }) {
  return (
    <div
      className={cn(
        'px-3 py-2 border-x border-b border-border bg-muted/20',
        !isFullscreen && 'rounded-br-lg',
      )}
    >
      <p className="text-[10px] text-muted-foreground italic">
        You can interact with the browser to handle logins or captchas
      </p>
    </div>
  );
}

export function BrowserViewBody({
  containerRef,
  taskId,
  messages,
  currentBrowserUrl,
  isThisFullscreen,
  isDisconnected,
  isResuming,
  pendingWriteLockApproval,
  onToggleFullscreen,
  onResume,
  onApprovalHandled,
}: BrowserViewBodyProps) {
  return (
    <div
      className={cn(
        'animate-in fade-in duration-300 w-full',
        isThisFullscreen && 'fixed inset-0 z-50 bg-background p-4',
      )}
    >
      <div
        ref={containerRef}
        className={cn(
          'max-w-4xl mx-auto relative',
          isThisFullscreen && 'h-full max-w-none flex flex-row',
        )}
      >
        {isThisFullscreen && <FullscreenActionsPanel taskId={taskId} />}

        <div className={cn('flex flex-col', isThisFullscreen ? 'flex-1' : 'w-full')}>
          <BrowserControls
            isFullscreen={isThisFullscreen}
            isDisconnected={isDisconnected}
            onToggleFullscreen={onToggleFullscreen}
          />

          <BrowserIframe
            taskId={taskId}
            url={currentBrowserUrl}
            messages={messages}
            isFullscreen={isThisFullscreen}
            isDisconnected={isDisconnected}
            isResuming={isResuming}
            onResume={onResume}
          />

          {pendingWriteLockApproval ? (
            <BrowserWriteLockApproval
              attentionRequestId={pendingWriteLockApproval.attentionRequestId}
              question={pendingWriteLockApproval.question}
              onApprovalHandled={onApprovalHandled}
            />
          ) : (
            <ControlHint isFullscreen={isThisFullscreen} />
          )}
        </div>
      </div>
    </div>
  );
}
