/**
 * BrowserAgentPane — an agent's live browser as shown inside the Browser app
 * drawer (replaces the old portaled fullscreen view). BrowserStatusBar portals
 * it into the drawer's agent-tab slot; it holds no session state itself.
 *
 * LAYOUT (stacked in both form factors, the drawer is a tall column):
 *   status row (Active / You have control / Waiting / Disconnected + proxy chip)
 *   live view: 8:5 letterbox of the fixed 1280x800 remote viewport
 *   [MOBILE only] control footer below the live view (never over it)
 *   task-progress panel filling the remaining height
 *
 * AGENT CONTROL STATE:
 * [DESKTOP_ACTIVE|WAITING|DISCONNECTED] -> controls overlay the live view
 * [MOBILE_ACTIVE|WAITING|DISCONNECTED] -> controls render in the footer below it
 * [USER_CONTROL] -> interactive iframe + Hand back control on both form factors
 * [READ_ONLY] -> passive iframe and task progress, no agent control actions
 *
 * VIEWPORT STATE:
 * [DESKTOP|MOBILE] -> letterbox the 1280x800 content viewport into the pane
 * (Steel chrome is clipped in LiveViewFrame). Never resize the remote
 * viewport: that breaks the antibot fingerprint (spoofed outer/screen vs a
 * pane-sized inner). Drawer resizes only change the letterbox scale.
 */

import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import BrowserBorderGlow from '../BrowserBorderGlow';
import { resolveBrowserBorderGlowTone } from '../browserBorderGlow/resolveTone';
import BrowserCursorOverlay from '../BrowserCursorOverlay';
import { resolveBrowserControlState, type BrowserControlState } from '../browserControlState';
import type { Message } from '../../hooks';
import {
  DisconnectedOverlay,
  MobileBrowserControlFooter,
  TakeControlChip,
  WaitingForAssistanceChip,
} from './BrowserFullscreenOverlays';
import { TaskProgressSidebar } from './BrowserTaskProgressPanel';
import { BrowserProxyLocationChip } from './BrowserProxyLocationChip';
import { LiveViewFrame } from './BrowserLiveViewFrame';
import type {
  BrowserSessionMetadata,
  OutputSchemaRef,
  PendingWriteLockApproval,
  StepProgress,
} from './types';

export interface BrowserAgentPaneProps {
  readOnly?: boolean;
  agentId?: string | null;
  taskId: string;
  browserUrl: string;
  /** False when the bound session is closed or ended: loading screen, no iframe. */
  browserLive?: boolean;
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

type LiveProps = Pick<
  BrowserAgentPaneProps,
  | 'agentId'
  | 'taskId'
  | 'browserUrl'
  | 'browserLive'
  | 'messages'
  | 'authAssistanceRequest'
  | 'isResuming'
  | 'isUserControlling'
  | 'onResume'
  | 'readOnly'
> & { isMobile: boolean; controlState: BrowserControlState };

/** Live iframe + agent overlays (desktop) — the remote viewport is letterboxed. */
function LiveBrowser({
  agentId,
  taskId,
  browserUrl,
  browserLive = true,
  messages,
  controlState,
  authAssistanceRequest,
  isResuming,
  isUserControlling,
  isMobile,
  onResume,
  readOnly = false,
}: LiveProps) {
  const glowTone = resolveBrowserBorderGlowTone(messages, taskId);
  const agentDriving = controlState === 'active' && !isUserControlling;
  return (
    <LiveViewFrame
      url={browserUrl}
      live={browserLive}
      title="Browser"
      interactive={!readOnly && (isUserControlling || controlState === 'waiting')}
      iframeKey={`${taskId}:${browserUrl}`}
      className="flex w-full flex-none flex-col bg-white"
      style={{ aspectRatio: '8 / 5', maxHeight: isMobile ? undefined : '68%' }}
    >
      {agentDriving && <BrowserBorderGlow tone={glowTone} />}
      {agentDriving && (
        <BrowserCursorOverlay agentId={agentId} taskId={taskId} messages={messages} />
      )}
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

export function BrowserAgentPane(props: BrowserAgentPaneProps) {
  const isMobile = useIsMobile();
  // Confirmed user ownership outranks stale disconnect/auth-assistance signals.
  // Those signals can remain in the message stream while the user is driving.
  const controlState = props.isUserControlling ? 'active' : resolveBrowserControlState(props);
  return (
    <div data-testid="browser-agent-pane" className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex flex-shrink-0 items-center justify-between gap-2 px-3.5 py-2">
        <ActiveIndicator controlState={controlState} isUserControlling={props.isUserControlling} />
        <BrowserProxyLocationChip
          metadata={props.browserSessionMetadata}
          tooltipPosition="bottom"
        />
      </div>
      <LiveBrowser
        readOnly={props.readOnly}
        agentId={props.agentId}
        taskId={props.taskId}
        browserUrl={props.browserUrl}
        browserLive={props.browserLive}
        messages={props.messages}
        controlState={controlState}
        authAssistanceRequest={props.authAssistanceRequest}
        isResuming={props.isResuming}
        isUserControlling={props.isUserControlling}
        isMobile={isMobile}
        onResume={props.onResume}
      />
      {isMobile && !props.readOnly && (
        <MobileBrowserControlFooter
          onResume={props.onResume}
          isResuming={props.isResuming}
          controlState={controlState}
          request={props.authAssistanceRequest}
          isUserControlling={props.isUserControlling}
        />
      )}
      <div className="min-h-0 flex-1 border-t border-border bg-background">
        <TaskProgressSidebar
          taskId={props.taskId}
          outputSchema={props.outputSchema}
          stepProgress={props.stepProgress}
          controlState={controlState}
          pendingWriteLockApproval={props.pendingWriteLockApproval}
        />
      </div>
    </div>
  );
}
