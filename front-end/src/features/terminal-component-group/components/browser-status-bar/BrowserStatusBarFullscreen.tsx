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
 * PHONE STATE: owned phone activity -> WAITING|ACTIVE overlay above the mounted iframe;
 * optional setup status changes only the shared label, below queue/read-only/user precedence;
 * native attention resolves exact authenticated binding before any mutation;
 * release -> same iframe. Phone owns controls while visible; mobile pane fits portrait
 * above always-visible progress. READ_ONLY -> frames only, no control/input.
 *
 * VIEWPORT STATE:
 * [DESKTOP|MOBILE] -> letterbox the 1280x800 content viewport into the leftover
 * pane (Steel chrome is clipped in LiveViewFrame). Never resize the remote
 * viewport: that breaks antibot fingerprint (spoofed outer/screen vs a
 * pane-sized inner).
 */

import { createPortal } from 'react-dom';
import type { MouseEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { resolveBrowserControlState, type BrowserControlState } from '../browserControlState';
import type { Message } from '../../hooks';
import { BrowserPaneBody } from './BrowserFullscreenPane';
import { usePhoneAttention } from './phone/usePhoneAttention';
import { phoneStatus as resolvePhoneStatus } from './phone/phoneStatus';
import { phoneActivityKey } from './phone/phoneOverlayState';
import { usePhoneOverlay } from './phone/usePhoneOverlay';
import { MobileBrowserControlFooter } from './BrowserFullscreenOverlays';
import { TaskProgressSidebar } from './BrowserTaskProgressPanel';
import {
  DesktopFrameHeader,
  MobileFrameHeader,
  type PhoneHeaderStatus,
} from './BrowserFullscreenHeaders';
import type {
  BrowserSessionMetadata,
  OutputSchemaRef,
  PendingWriteLockApproval,
  StepProgress,
} from './types';

export interface FullscreenProps {
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
  onClose: (e: MouseEvent) => void;
  onResume: () => void;
}

function MobileFullscreen({
  props,
  controlState,
  pane,
  progressPanel,
  phoneStatus,
  phoneVisible,
}: {
  props: FullscreenProps;
  controlState: BrowserControlState;
  pane: ReactNode;
  progressPanel: ReactNode;
  phoneVisible: boolean;
  phoneStatus?: PhoneHeaderStatus;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <MobileFrameHeader
        phoneStatus={phoneStatus}
        controlState={controlState}
        isUserControlling={props.isUserControlling}
        onClose={props.onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {pane}
        {!phoneVisible && !props.readOnly && (
          <MobileBrowserControlFooter
            onResume={props.onResume}
            isResuming={props.isResuming}
            controlState={controlState}
            request={props.authAssistanceRequest}
            isUserControlling={props.isUserControlling}
          />
        )}
        <div
          className={cn(
            'min-h-0 border-t border-border bg-background',
            phoneVisible ? 'h-[80px] flex-none' : 'flex-1',
          )}
        >
          {progressPanel}
        </div>
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
  phoneStatus,
}: {
  props: FullscreenProps;
  controlState: BrowserControlState;
  pane: ReactNode;
  progressPanel: ReactNode;
  phoneStatus?: PhoneHeaderStatus;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-row bg-background">
      {progressPanel}
      <div className="flex min-w-0 flex-1 flex-col">
        <DesktopFrameHeader
          phoneStatus={phoneStatus}
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
  const attention = usePhoneAttention(
    props.taskId,
    props.agentId,
    props.messages,
    props.readOnly ?? false,
  );
  const phone = usePhoneOverlay(
    props.taskId,
    attention.id
      ? `auth:${attention.id}`
      : props.isWaitingForAuthAssistance
        ? ''
        : phoneActivityKey(props.messages, props.taskId),
    props.readOnly ?? false,
    attention.request,
    props.agentId ?? undefined,
  );
  const phoneStatus = resolvePhoneStatus(phone, props.readOnly ?? false);
  // Confirmed user ownership outranks stale disconnect/auth-assistance signals.
  // Those signals can remain in the message stream while the user is driving.
  const controlState = props.isUserControlling ? 'active' : resolveBrowserControlState(props);

  const pane = (
    <BrowserPaneBody
      {...props}
      attention={attention}
      phone={phone}
      controlState={controlState}
      isMobile={isMobile}
    />
  );

  const progressPanel = (
    <TaskProgressSidebar
      taskId={props.taskId}
      outputSchema={props.outputSchema}
      stepProgress={props.stepProgress}
      controlState={controlState}
      pendingWriteLockApproval={props.pendingWriteLockApproval}
    />
  );

  return isMobile ? (
    <MobileFullscreen
      phoneStatus={phoneStatus}
      phoneVisible={phone.visible || !!attention.id}
      props={props}
      controlState={controlState}
      pane={pane}
      progressPanel={progressPanel}
    />
  ) : (
    <DesktopFullscreen
      phoneStatus={phoneStatus}
      props={props}
      controlState={controlState}
      pane={pane}
      progressPanel={progressPanel}
    />
  );
}
