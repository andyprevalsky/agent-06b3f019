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
 * [USER_CONTROL] -> interactive iframe + Hand back control on both form factors
 * [READ_ONLY] -> passive iframe and task progress, no agent control actions
 *
 * VIEWPORT STATE:
 * [DESKTOP|MOBILE] -> letterbox the 1280x800 content viewport into the leftover
 * pane (Steel chrome is clipped in LiveViewFrame). Never resize the remote
 * viewport: that breaks antibot fingerprint (spoofed outer/screen vs a
 * pane-sized inner).
 */

import { createPortal } from 'react-dom';
import type { MouseEvent, ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import BrowserBorderGlow from '../../BrowserBorderGlow';
import { resolveBrowserBorderGlowTone } from '../../browserBorderGlow/resolveTone';
import BrowserCursorOverlay from '../../BrowserCursorOverlay';
import { resolveBrowserControlState, type BrowserControlState } from '../../browserControlState';
import type { Message } from '../../../hooks';
import {
  DisconnectedOverlay,
  MobileBrowserControlFooter,
  TakeControlChip,
  WaitingForAssistanceChip,
} from '../BrowserFullscreenOverlays';
import { TaskProgressSidebar } from './BrowserTaskProgressPanel';
import { BrowserProxyLocationChip } from '../BrowserProxyLocationChip';
import { LiveViewFrame } from '../BrowserLiveViewFrame';
import type {
  BrowserSessionMetadata,
  OutputSchemaRef,
  PendingWriteLockApproval,
  StepProgress,
} from '../types';

interface FullscreenProps {
  readOnly?: boolean;
  agentId?: string | null;
  taskId: string;
  browserUrl: string;
  /** False when the bound session is closed or ended: loading screen, no iframe. */
  browserLive?: boolean;
  /** The owning agent finished: show a terminal "session ended" state, never "Connecting…". */
  browserEnded?: boolean;
  messages: Message[];
  outputSchema: OutputSchemaRef | undefined;
  browserSessionMetadata: BrowserSessionMetadata | null;
  stepProgress: StepProgress | null;
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
  authAssistanceRequest?: string;
  isResuming: boolean;
  isUserControlling: boolean;
  pendingWriteLockApproval: PendingWriteLockApproval | null;
  onClose: (e: MouseEvent) => void;
  onResume: () => void;
}

function ActiveIndicator({
  controlState,
  isUserControlling,
}: {
  controlState: BrowserControlState;
  isUserControlling: boolean;
}) {
  const label = isUserControlling
    ? 'You have control'
    : controlState === 'disconnected'
      ? 'Disconnected'
      : controlState === 'waiting'
        ? 'Waiting for assistance'
        : 'Active';
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div
        className={cn(
          'h-2 w-2 flex-shrink-0 rounded-full',
          controlState === 'active' ? 'bg-green-500 animate-pulse' : 'bg-yellow-500',
        )}
      />
      <span className="truncate text-sm font-medium">{label}</span>
    </div>
  );
}

/** Desktop frame header: Active state + proxy chip + close. */
function DesktopFrameHeader({
  controlState,
  browserSessionMetadata,
  onClose,
  isUserControlling,
}: {
  controlState: BrowserControlState;
  browserSessionMetadata: BrowserSessionMetadata | null;
  onClose: (e: MouseEvent) => void;
  isUserControlling: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border p-4">
      <ActiveIndicator controlState={controlState} isUserControlling={isUserControlling} />
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
  controlState,
  onClose,
  isUserControlling,
}: {
  controlState: BrowserControlState;
  onClose: (e: MouseEvent) => void;
  isUserControlling: boolean;
}) {
  return (
    <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border p-3">
      <ActiveIndicator controlState={controlState} isUserControlling={isUserControlling} />
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
  | 'browserLive'
  | 'browserEnded'
  | 'messages'
  | 'authAssistanceRequest'
  | 'isResuming'
  | 'isUserControlling'
  | 'onResume'
  | 'readOnly'
> & {
  isMobile: boolean;
  controlState: BrowserControlState;
};

/** Live-iframe pane + agent overlays. No header or redundant helper footer. */
function BrowserPaneBody({
  agentId,
  taskId,
  browserUrl,
  browserLive = true,
  browserEnded = false,
  messages,
  controlState,
  authAssistanceRequest,
  isResuming,
  isUserControlling,
  isMobile,
  onResume,
  readOnly = false,
}: PaneProps) {
  const glowTone = resolveBrowserBorderGlowTone(messages, taskId);
  return (
    <LiveViewFrame
      url={browserUrl}
      live={browserLive}
      ended={browserEnded}
      title="Browser"
      interactive={!readOnly && (isUserControlling || controlState === 'waiting')}
      iframeKey={`${taskId}:${browserUrl}`}
      className={cn('flex min-h-0 flex-col bg-white', isMobile ? 'w-full flex-none' : 'flex-1')}
      style={isMobile ? { aspectRatio: '8 / 5' } : undefined}
    >
      {!browserEnded && controlState === 'active' && !isUserControlling && (
        <BrowserBorderGlow tone={glowTone} />
      )}
      <BrowserCursorOverlay
        agentId={agentId}
        taskId={taskId}
        messages={messages}
        browserUrl={browserUrl}
        visible={!browserEnded && controlState === 'active' && !isUserControlling}
      />
      {!readOnly && !isMobile && controlState === 'active' && (
        <TakeControlChip
          onResume={onResume}
          isResuming={isResuming}
          isUserControlling={isUserControlling}
        />
      )}
      {!readOnly && !isMobile && controlState === 'waiting' && (
        <WaitingForAssistanceChip
          onResume={onResume}
          isResuming={isResuming}
          request={authAssistanceRequest ?? 'Complete the sign-in so I can continue'}
          isMobile={isMobile}
        />
      )}
      {!readOnly && !isMobile && controlState === 'disconnected' && (
        <DisconnectedOverlay onResume={onResume} isResuming={isResuming} />
      )}
    </LiveViewFrame>
  );
}

function MobileFullscreen({
  props,
  controlState,
  pane,
  progressPanel,
}: {
  props: FullscreenProps;
  controlState: BrowserControlState;
  pane: ReactNode;
  progressPanel: ReactNode;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <MobileFrameHeader
        controlState={controlState}
        isUserControlling={props.isUserControlling}
        onClose={props.onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {pane}
        {!props.readOnly && (
          <MobileBrowserControlFooter
            onResume={props.onResume}
            isResuming={props.isResuming}
            controlState={controlState}
            request={props.authAssistanceRequest}
            isUserControlling={props.isUserControlling}
          />
        )}
        <div className="min-h-0 flex-1 border-t border-border bg-background">{progressPanel}</div>
      </div>
    </div>,
    document.body,
  );
}

function DesktopFullscreen({
  props,
  controlState,
  pane,
  progressPanel,
}: {
  props: FullscreenProps;
  controlState: BrowserControlState;
  pane: ReactNode;
  progressPanel: ReactNode;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-row bg-background">
      {progressPanel}
      <div className="flex min-w-0 flex-1 flex-col">
        <DesktopFrameHeader
          controlState={controlState}
          browserSessionMetadata={props.browserSessionMetadata}
          isUserControlling={props.isUserControlling}
          onClose={props.onClose}
        />
        {pane}
      </div>
    </div>,
    document.body,
  );
}

export function BrowserStatusBarFullscreen(props: FullscreenProps) {
  const isMobile = useIsMobile();
  // Confirmed user ownership outranks stale disconnect/auth-assistance signals.
  // Those signals can remain in the message stream while the user is driving.
  const controlState = props.isUserControlling ? 'active' : resolveBrowserControlState(props);

  const pane = (
    <BrowserPaneBody
      readOnly={props.readOnly}
      agentId={props.agentId}
      taskId={props.taskId}
      browserUrl={props.browserUrl}
      browserLive={props.browserLive}
      browserEnded={props.browserEnded}
      messages={props.messages}
      controlState={controlState}
      authAssistanceRequest={props.authAssistanceRequest}
      isResuming={props.isResuming}
      isUserControlling={props.isUserControlling}
      isMobile={isMobile}
      onResume={props.onResume}
    />
  );

  const progressPanel = (
    <TaskProgressSidebar
      taskId={props.taskId}
      outputSchema={props.outputSchema}
      stepProgress={props.stepProgress}
      controlState={controlState}
      pendingWriteLockApproval={props.pendingWriteLockApproval}
      isMobile={isMobile}
    />
  );

  return isMobile ? (
    <MobileFullscreen
      props={props}
      controlState={controlState}
      pane={pane}
      progressPanel={progressPanel}
    />
  ) : (
    <DesktopFullscreen
      props={props}
      controlState={controlState}
      pane={pane}
      progressPanel={progressPanel}
    />
  );
}
