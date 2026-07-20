/**
 * STATE MACHINE: BrowserViewBody
 *
 * FRAME STATE:
 * [ACTIVE] -> controls + iframe active overlay affordances
 * [WAITING_FOR_AUTH_ASSISTANCE] -> iframe resume overlay with Start Agent
 * [DISCONNECTED] -> iframe resume overlay with Take Control
 *
 * FULLSCREEN STATE:
 * [INLINE] <-> [FULLSCREEN]
 *
 * FULLSCREEN LAYOUT:
 * [DESKTOP] -> horizontal split (flex-row): fixed-width actions panel + iframe
 * [MOBILE]  -> stacked (flex-col): iframe takes full width; the actions panel is
 *              reachable behind a "Task progress" toggle that opens it as a
 *              full-screen overlay (a fixed 320px column would clip the iframe
 *              to a sliver on a phone).
 *
 * MOBILE ACTIONS PANEL STATE (fullscreen only):
 * [HIDDEN] --tap Task progress--> [OPEN overlay] --tap close--> [HIDDEN]
 */

import { useState } from 'react';
import { PanelRightOpen, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import type { Message } from '../../hooks';
import { BrowserControls } from './BrowserControls';
import { BrowserIframe } from './BrowserIframe';
import { BrowserWriteLockApproval } from './BrowserWriteLockApproval';
import { FullscreenActionsPanel } from './ActionsPanel';
import type { PendingWriteLockApproval } from './hooks';

interface BrowserViewBodyProps {
  containerRef: React.RefObject<HTMLDivElement>;
  agentId?: string | null;
  taskId: string;
  messages: Message[];
  currentBrowserUrl: string;
  isThisFullscreen: boolean;
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
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

function MobileTaskProgressToggle({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      aria-label="Show task progress"
      className="flex items-center justify-center gap-1.5 border-x border-t border-border bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
    >
      <PanelRightOpen className="h-4 w-4" />
      Task progress
    </button>
  );
}

function MobileActionsOverlay({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border p-3">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Task progress
        </h4>
        <button
          onClick={onClose}
          aria-label="Close task progress"
          className="p-1 rounded hover:bg-muted transition-colors"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
      <FullscreenActionsPanel taskId={taskId} fullWidth />
    </div>
  );
}

export function BrowserViewBody({
  containerRef,
  agentId,
  taskId,
  messages,
  currentBrowserUrl,
  isThisFullscreen,
  isDisconnected,
  isWaitingForAuthAssistance,
  isResuming,
  pendingWriteLockApproval,
  onToggleFullscreen,
  onResume,
  onApprovalHandled,
}: BrowserViewBodyProps) {
  const isMobile = useIsMobile();
  const [showMobileActions, setShowMobileActions] = useState(false);
  const stackedFullscreen = isThisFullscreen && isMobile;

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
          isThisFullscreen && 'h-full max-w-none flex',
          isThisFullscreen && (stackedFullscreen ? 'flex-col' : 'flex-row'),
        )}
      >
        {isThisFullscreen && !isMobile && <FullscreenActionsPanel taskId={taskId} />}

        <div className={cn('flex flex-col min-w-0', isThisFullscreen ? 'flex-1' : 'w-full')}>
          {stackedFullscreen && (
            <MobileTaskProgressToggle onOpen={() => setShowMobileActions(true)} />
          )}

          <BrowserControls
            isFullscreen={isThisFullscreen}
            isDisconnected={isDisconnected}
            isWaitingForAuthAssistance={isWaitingForAuthAssistance}
            onToggleFullscreen={onToggleFullscreen}
          />

          <BrowserIframe
            agentId={agentId}
            taskId={taskId}
            url={currentBrowserUrl}
            messages={messages}
            isFullscreen={isThisFullscreen}
            isDisconnected={isDisconnected}
            isWaitingForAuthAssistance={isWaitingForAuthAssistance}
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

        {stackedFullscreen && showMobileActions && (
          <MobileActionsOverlay taskId={taskId} onClose={() => setShowMobileActions(false)} />
        )}
      </div>
    </div>
  );
}
