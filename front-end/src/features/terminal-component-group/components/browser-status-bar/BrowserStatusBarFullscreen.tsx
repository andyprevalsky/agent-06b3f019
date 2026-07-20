/**
 * BrowserStatusBarFullscreen — the portaled fullscreen variant of
 * BrowserStatusBar.
 *
 * DESKTOP LAYOUT (>= md): the task-progress panel sits as a fixed-width left
 * column beside the live iframe (horizontal split).
 *
 * MOBILE LAYOUT (< md): the fixed-width panel would clip the iframe to a
 * sliver, so it is NOT rendered inline — the iframe pane takes the FULL
 * viewport width, and the task progress is reachable behind a header toggle
 * that opens it as a full-screen overlay (stacked / tabbed presentation).
 *
 * Presentational — agent/session state is owned by BrowserStatusBar; only the
 * mobile progress-panel visibility is local state here.
 *
 * AGENT OVERLAY STATE:
 * [ACTIVE] -> border glow + cursor stitch + "Agent in progress" chip
 * [WAITING_FOR_AUTH_ASSISTANCE] -> connected request + "Agent waiting for assistance" handoff
 * [DISCONNECTED] -> blurred resume overlay
 *
 * MOBILE PROGRESS PANEL STATE:
 * [HIDDEN] --tap Progress toggle--> [OPEN overlay]
 * [OPEN overlay] --tap close--> [HIDDEN]
 *
 * VIEWPORT STATE:
 * [MOUNTED] -> observe browser pane -> debounce dimensions -> resize remote provider viewport
 * (derives from the pane element size, so a full-width mobile pane resizes the
 *  remote session to full width automatically)
 */

import { createPortal } from 'react-dom';
import { useRef, useState, type MouseEvent, type RefObject } from 'react';
import { PanelRightOpen, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import BrowserBorderGlow from '../BrowserBorderGlow';
import BrowserCursorOverlay from '../BrowserCursorOverlay';
import type { Message } from '../../hooks';
import {
  DisconnectedOverlay,
  TakeControlChip,
  WaitingForAssistanceChip,
} from './BrowserFullscreenOverlays';
import { TaskProgressSidebar } from './BrowserTaskProgressPanel';
import { BrowserProxyLocationChip } from './BrowserProxyLocationChip';
import { useBrowserViewportSync } from './useBrowserViewportSync';
import type {
  BrowserSessionMetadata,
  OutputSchemaRef,
  PendingWriteLockApproval,
  StepProgress,
} from './types';

interface FullscreenProps {
  agentId?: string | null;
  taskId: string;
  browserUrl: string;
  messages: Message[];
  outputSchema: OutputSchemaRef | undefined;
  browserSessionMetadata: BrowserSessionMetadata | null;
  stepProgress: StepProgress | null;
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
  authAssistanceRequest?: string;
  isResuming: boolean;
  pendingWriteLockApproval: PendingWriteLockApproval | null;
  onClose: (e: MouseEvent) => void;
  onResume: () => void;
}

function ActiveIndicator({
  isDisconnected,
  isWaitingForAuthAssistance,
}: {
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
}) {
  const label = isDisconnected
    ? 'Disconnected'
    : isWaitingForAuthAssistance
      ? 'Waiting for assistance'
      : 'Active';
  return (
    <div className="flex items-center gap-2">
      <div
        className={cn(
          'h-2 w-2 rounded-full',
          isDisconnected || isWaitingForAuthAssistance
            ? 'bg-yellow-500'
            : 'bg-green-500 animate-pulse',
        )}
      />
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

function BrowserFrameHeader({
  isDisconnected,
  isWaitingForAuthAssistance,
  browserSessionMetadata,
  onClose,
  isMobile,
  onToggleProgress,
}: {
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
  browserSessionMetadata: BrowserSessionMetadata | null;
  onClose: (e: MouseEvent) => void;
  isMobile: boolean;
  onToggleProgress: () => void;
}) {
  return (
    <div className="flex items-center justify-between p-4 border-b border-border">
      <ActiveIndicator
        isDisconnected={isDisconnected}
        isWaitingForAuthAssistance={isWaitingForAuthAssistance}
      />
      <div className="flex items-center gap-2">
        <BrowserProxyLocationChip metadata={browserSessionMetadata} tooltipPosition="bottom" />
        {isMobile && (
          <button
            onClick={onToggleProgress}
            aria-label="Show task progress"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
          >
            <PanelRightOpen className="h-4 w-4" />
            Progress
          </button>
        )}
        <button onClick={onClose} className="p-2 rounded hover:bg-muted transition-colors">
          <X className="h-5 w-5 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}

type BrowserColumnProps = Pick<
  FullscreenProps,
  | 'agentId'
  | 'taskId'
  | 'browserUrl'
  | 'messages'
  | 'browserSessionMetadata'
  | 'isDisconnected'
  | 'isWaitingForAuthAssistance'
  | 'authAssistanceRequest'
  | 'isResuming'
  | 'onClose'
  | 'onResume'
> & {
  paneRef: RefObject<HTMLDivElement>;
  isMobile: boolean;
  onToggleProgress: () => void;
};

/** The live-iframe column: frame header, pane + agent overlays, and hint footer. */
function FullscreenBrowserColumn({
  paneRef,
  agentId,
  taskId,
  browserUrl,
  messages,
  browserSessionMetadata,
  isDisconnected,
  isWaitingForAuthAssistance,
  authAssistanceRequest,
  isResuming,
  isMobile,
  onClose,
  onResume,
  onToggleProgress,
}: BrowserColumnProps) {
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <BrowserFrameHeader
        isDisconnected={isDisconnected}
        isWaitingForAuthAssistance={isWaitingForAuthAssistance}
        browserSessionMetadata={browserSessionMetadata}
        onClose={onClose}
        isMobile={isMobile}
        onToggleProgress={onToggleProgress}
      />
      <div ref={paneRef} className="flex-1 relative bg-white">
        <iframe
          src={browserUrl}
          className="w-full h-full border-0"
          allow="clipboard-read; clipboard-write"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
          title="Browser"
        />
        {!isWaitingForAuthAssistance && <BrowserBorderGlow />}
        {!isWaitingForAuthAssistance && (
          <BrowserCursorOverlay agentId={agentId} taskId={taskId} messages={messages} />
        )}
        {!isDisconnected && !isWaitingForAuthAssistance && (
          <TakeControlChip onResume={onResume} isResuming={isResuming} />
        )}
        {isWaitingForAuthAssistance && (
          <WaitingForAssistanceChip
            onResume={onResume}
            isResuming={isResuming}
            request={authAssistanceRequest ?? 'Complete the sign-in so I can continue'}
            isMobile={isMobile}
          />
        )}
        {isDisconnected && !isWaitingForAuthAssistance && (
          <DisconnectedOverlay onResume={onResume} isResuming={isResuming} />
        )}
      </div>
      <div className="px-4 py-2 border-t border-border bg-muted/20">
        <p className="text-xs text-muted-foreground italic">
          You can interact with the browser to handle logins or captchas
        </p>
      </div>
    </div>
  );
}

export function BrowserStatusBarFullscreen(props: FullscreenProps) {
  const {
    agentId,
    taskId,
    browserUrl,
    messages,
    outputSchema,
    browserSessionMetadata,
    stepProgress,
    isDisconnected,
    isWaitingForAuthAssistance,
    authAssistanceRequest,
    isResuming,
    pendingWriteLockApproval,
    onClose,
    onResume,
  } = props;
  const browserPaneRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [showMobileProgress, setShowMobileProgress] = useState(false);
  useBrowserViewportSync(taskId, browserPaneRef);

  return createPortal(
    <div className="fixed inset-0 z-50 bg-background flex flex-row">
      {!isMobile && (
        <TaskProgressSidebar
          taskId={taskId}
          outputSchema={outputSchema}
          stepProgress={stepProgress}
          isDisconnected={isDisconnected}
          isWaitingForAuthAssistance={isWaitingForAuthAssistance}
          pendingWriteLockApproval={pendingWriteLockApproval}
        />
      )}

      <FullscreenBrowserColumn
        paneRef={browserPaneRef}
        agentId={agentId}
        taskId={taskId}
        browserUrl={browserUrl}
        messages={messages}
        browserSessionMetadata={browserSessionMetadata}
        isDisconnected={isDisconnected}
        isWaitingForAuthAssistance={isWaitingForAuthAssistance}
        authAssistanceRequest={authAssistanceRequest}
        isResuming={isResuming}
        isMobile={isMobile}
        onClose={onClose}
        onResume={onResume}
        onToggleProgress={() => setShowMobileProgress((prev) => !prev)}
      />

      {isMobile && showMobileProgress && (
        <div className="absolute inset-0 z-20 flex flex-col bg-background">
          <TaskProgressSidebar
            taskId={taskId}
            outputSchema={outputSchema}
            stepProgress={stepProgress}
            isDisconnected={isDisconnected}
            isWaitingForAuthAssistance={isWaitingForAuthAssistance}
            pendingWriteLockApproval={pendingWriteLockApproval}
            isMobile
            onClose={() => setShowMobileProgress(false)}
          />
        </div>
      )}
    </div>,
    document.body,
  );
}
