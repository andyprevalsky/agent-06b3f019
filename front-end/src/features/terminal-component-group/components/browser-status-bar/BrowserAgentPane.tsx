/**
 * BrowserAgentPane — an agent's live browser as shown inside the Browser app
 * drawer (replaces the old portaled fullscreen view). BrowserStatusBar portals
 * it into the drawer's agent-tab slot; it holds no session state itself.
 *
 * LAYOUT: desktop trajectory on the left, letterboxed live browser on the right.
 * Mobile keeps the browser, control footer and trajectory stacked.
 * Proxy location belongs to the drawer's mode/tab row, not a separate status bar.
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
import { useRoseApps } from '../rose-apps/roseAppsState';
import { TaskProgressSidebar } from './BrowserTaskProgressPanel';
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
      className={`flex w-full flex-col bg-white ${isMobile ? 'flex-none' : 'flex-1'}`}
      style={isMobile ? { aspectRatio: '8 / 5' } : undefined}
    >
      {agentDriving && <BrowserBorderGlow tone={glowTone} />}
      {/* Always mounted: hiding (not unmounting) keeps the cursor's glide + bob steady. */}
      <BrowserCursorOverlay
        agentId={agentId}
        taskId={taskId}
        messages={messages}
        browserUrl={browserUrl}
        visible={agentDriving}
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

export function BrowserAgentPane(props: BrowserAgentPaneProps) {
  const isMobile = useIsMobile();
  const apps = useRoseApps();
  // Confirmed user ownership outranks stale disconnect/auth-assistance signals.
  // Those signals can remain in the message stream while the user is driving.
  const controlState = props.isUserControlling ? 'active' : resolveBrowserControlState(props);
  return (
    <div
      data-testid="browser-agent-pane"
      className={`flex min-h-0 min-w-0 flex-1 bg-background ${isMobile ? 'flex-col' : 'flex-row'}`}
    >
      <div
        data-testid="browser-trajectory-column"
        className={
          isMobile
            ? 'order-2 flex min-h-0 flex-1 flex-col border-t border-border'
            : 'order-1 flex min-h-0 w-[min(320px,35%)] flex-none flex-col border-r border-border'
        }
      >
        <div className="min-h-0 flex-1">
          <TaskProgressSidebar
            taskId={props.taskId}
            outputSchema={props.outputSchema}
            stepProgress={props.stepProgress}
            controlState={controlState}
            pendingWriteLockApproval={props.pendingWriteLockApproval}
          />
        </div>
        {!props.readOnly && (
          <div
            ref={apps?.setBrowserComposerSlot}
            data-testid="browser-composer-slot"
            data-agent-id={props.agentId ?? ''}
            data-task-id={props.taskId}
            className="flex-none p-3"
          />
        )}
      </div>
      <div
        data-testid="browser-content-column"
        className={`min-h-0 min-w-0 ${isMobile ? 'order-1 flex-none' : 'order-2 flex-1'} flex flex-col`}
      >
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
      </div>
    </div>
  );
}
