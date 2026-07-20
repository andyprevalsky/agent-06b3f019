/**
 * BrowserStatusBarFullscreen — the portaled fullscreen variant of
 * BrowserStatusBar.
 *
 * DESKTOP LAYOUT (>= md): the task-progress panel sits as a fixed-width left
 * column beside the live iframe (horizontal split); the frame header lives above
 * the iframe.
 *
 * MOBILE LAYOUT (< md): one fixed view stacks the header, a full-width 8:5
 * desktop browser, its control footer, then the always-visible task-progress
 * panel. There is no mode toggle and the browser stays mounted while progress
 * scrolls below it.
 *
 * Presentational — agent/session state is owned by BrowserStatusBar.
 *
 * AGENT CONTROL STATE:
 * [DESKTOP_ACTIVE|WAITING|DISCONNECTED] -> controls overlay the browser
 * [MOBILE_ACTIVE|WAITING|DISCONNECTED] -> controls render in the footer below it
 *
 * VIEWPORT STATE:
 * [DESKTOP] -> observe browser pane -> debounce dimensions -> resize remote provider viewport
 * [MOBILE] -> preserve the provider's desktop viewport and scale it into the
 * aspect-matched full-width pane
 */

import { createPortal } from 'react-dom';
import { useRef, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import BrowserBorderGlow from '../BrowserBorderGlow';
import BrowserCursorOverlay from '../BrowserCursorOverlay';
import type { Message } from '../../hooks';
import {
  DisconnectedOverlay,
  MobileBrowserControlFooter,
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
    <div className="flex min-w-0 items-center gap-2">
      <div
        className={cn(
          'h-2 w-2 flex-shrink-0 rounded-full',
          isDisconnected || isWaitingForAuthAssistance
            ? 'bg-yellow-500'
            : 'bg-green-500 animate-pulse',
        )}
      />
      <span className="truncate text-sm font-medium">{label}</span>
    </div>
  );
}

/** Desktop frame header: Active state + proxy chip + close. */
function DesktopFrameHeader({
  isDisconnected,
  isWaitingForAuthAssistance,
  browserSessionMetadata,
  onClose,
}: {
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
  browserSessionMetadata: BrowserSessionMetadata | null;
  onClose: (e: MouseEvent) => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border p-4">
      <ActiveIndicator
        isDisconnected={isDisconnected}
        isWaitingForAuthAssistance={isWaitingForAuthAssistance}
      />
      <div className="flex items-center gap-2">
        <BrowserProxyLocationChip metadata={browserSessionMetadata} tooltipPosition="bottom" />
        <button onClick={onClose} className="rounded p-2 transition-colors hover:bg-muted">
          <X className="h-5 w-5 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}

/** Fixed mobile header: Active state + close. */
function MobileFrameHeader({
  isDisconnected,
  isWaitingForAuthAssistance,
  onClose,
}: {
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
  onClose: (e: MouseEvent) => void;
}) {
  return (
    <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border p-3">
      <ActiveIndicator
        isDisconnected={isDisconnected}
        isWaitingForAuthAssistance={isWaitingForAuthAssistance}
      />
      <button onClick={onClose} className="rounded p-1.5 transition-colors hover:bg-muted">
        <X className="h-5 w-5 text-muted-foreground" />
      </button>
    </div>
  );
}

type PaneProps = Pick<
  FullscreenProps,
  | 'agentId'
  | 'taskId'
  | 'browserUrl'
  | 'messages'
  | 'isDisconnected'
  | 'isWaitingForAuthAssistance'
  | 'authAssistanceRequest'
  | 'isResuming'
  | 'onResume'
> & {
  paneRef: RefObject<HTMLDivElement>;
  isMobile: boolean;
};

/** Live-iframe pane + agent overlays. No header or redundant helper footer. */
function BrowserPaneBody({
  paneRef,
  agentId,
  taskId,
  browserUrl,
  messages,
  isDisconnected,
  isWaitingForAuthAssistance,
  authAssistanceRequest,
  isResuming,
  isMobile,
  onResume,
}: PaneProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-col',
        isMobile ? 'w-full flex-none overflow-hidden' : 'flex-1',
      )}
      // Kernel streams at 1280x800 (8:5). An explicit aspect ratio keeps the
      // cross-origin player edge-to-edge without depending on generated CSS.
      style={isMobile ? { aspectRatio: '8 / 5' } : undefined}
    >
      <div ref={paneRef} className="relative flex-1 bg-white">
        <iframe
          src={browserUrl}
          className="h-full w-full border-0"
          allow="clipboard-read; clipboard-write"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
          title="Browser"
        />
        {!isWaitingForAuthAssistance && <BrowserBorderGlow />}
        {!isWaitingForAuthAssistance && (
          <BrowserCursorOverlay agentId={agentId} taskId={taskId} messages={messages} />
        )}
        {!isMobile && !isDisconnected && !isWaitingForAuthAssistance && (
          <TakeControlChip onResume={onResume} isResuming={isResuming} />
        )}
        {!isMobile && isWaitingForAuthAssistance && (
          <WaitingForAssistanceChip
            onResume={onResume}
            isResuming={isResuming}
            request={authAssistanceRequest ?? 'Complete the sign-in so I can continue'}
            isMobile={isMobile}
          />
        )}
        {!isMobile && isDisconnected && !isWaitingForAuthAssistance && (
          <DisconnectedOverlay onResume={onResume} isResuming={isResuming} />
        )}
      </div>
    </div>
  );
}

function MobileFullscreen({
  props,
  pane,
  progressPanel,
}: {
  props: FullscreenProps;
  pane: ReactNode;
  progressPanel: ReactNode;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <MobileFrameHeader
        isDisconnected={props.isDisconnected}
        isWaitingForAuthAssistance={props.isWaitingForAuthAssistance}
        onClose={props.onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {pane}
        <MobileBrowserControlFooter
          onResume={props.onResume}
          isResuming={props.isResuming}
          isDisconnected={props.isDisconnected}
          isWaitingForAuthAssistance={props.isWaitingForAuthAssistance}
          request={props.authAssistanceRequest}
        />
        <div className="min-h-0 flex-1 border-t border-border bg-background">{progressPanel}</div>
      </div>
    </div>,
    document.body,
  );
}

function DesktopFullscreen({
  props,
  pane,
  progressPanel,
}: {
  props: FullscreenProps;
  pane: ReactNode;
  progressPanel: ReactNode;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-row bg-background">
      {progressPanel}
      <div className="flex min-w-0 flex-1 flex-col">
        <DesktopFrameHeader
          isDisconnected={props.isDisconnected}
          isWaitingForAuthAssistance={props.isWaitingForAuthAssistance}
          browserSessionMetadata={props.browserSessionMetadata}
          onClose={props.onClose}
        />
        {pane}
      </div>
    </div>,
    document.body,
  );
}

export function BrowserStatusBarFullscreen(props: FullscreenProps) {
  const browserPaneRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  useBrowserViewportSync(props.taskId, browserPaneRef, !isMobile);

  const pane = (
    <BrowserPaneBody
      paneRef={browserPaneRef}
      agentId={props.agentId}
      taskId={props.taskId}
      browserUrl={props.browserUrl}
      messages={props.messages}
      isDisconnected={props.isDisconnected}
      isWaitingForAuthAssistance={props.isWaitingForAuthAssistance}
      authAssistanceRequest={props.authAssistanceRequest}
      isResuming={props.isResuming}
      isMobile={isMobile}
      onResume={props.onResume}
    />
  );

  const progressPanel = (
    <TaskProgressSidebar
      taskId={props.taskId}
      outputSchema={props.outputSchema}
      stepProgress={props.stepProgress}
      isDisconnected={props.isDisconnected}
      isWaitingForAuthAssistance={props.isWaitingForAuthAssistance}
      pendingWriteLockApproval={props.pendingWriteLockApproval}
      isMobile={isMobile}
    />
  );

  return isMobile ? (
    <MobileFullscreen props={props} pane={pane} progressPanel={progressPanel} />
  ) : (
    <DesktopFullscreen props={props} pane={pane} progressPanel={progressPanel} />
  );
}
