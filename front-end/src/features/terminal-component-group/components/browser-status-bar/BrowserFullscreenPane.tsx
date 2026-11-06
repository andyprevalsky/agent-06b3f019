/** [BROWSER] one mounted iframe -> [PHONE] exact attention overlay -> [CLOSE] same browser restored. */
import { cn } from '@/lib/utils';
import BrowserBorderGlow from '../BrowserBorderGlow';
import { resolveBrowserBorderGlowTone } from '../browserBorderGlow/resolveTone';
import BrowserCursorOverlay from '../BrowserCursorOverlay';
import type { BrowserControlState } from '../browserControlState';
import type { PhoneOverlayModel } from './phone/usePhoneOverlay';
import { PhoneOverlay } from './phone/PhoneOverlay';
import {
  DisconnectedOverlay,
  TakeControlChip,
  WaitingForAssistanceChip,
} from './BrowserFullscreenOverlays';
import { LiveViewFrame } from './BrowserLiveViewFrame';
import type { FullscreenProps } from './BrowserStatusBarFullscreen';
import type { PhoneAttentionModel } from './phone/usePhoneAttention';
import { PhoneAttentionNotice } from './phone/PhoneAttentionNotice';
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
  phone: PhoneOverlayModel;
  attention: PhoneAttentionModel;
};

/** Live-iframe pane + agent overlays. No header or redundant helper footer. */
export function BrowserPaneBody({
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
  phone,
  attention,
}: PaneProps) {
  const glowTone = resolveBrowserBorderGlowTone(messages, taskId);
  return (
    <LiveViewFrame
      url={browserUrl}
      live={browserLive}
      ended={browserEnded}
      title="Browser"
      interactive={
        !attention.id &&
        !phone.visible &&
        !attention.id &&
        !readOnly &&
        (isUserControlling || controlState === 'waiting')
      }
      iframeKey={`${taskId}:${browserUrl}`}
      className={cn(
        'flex min-h-0 flex-col bg-white',
        isMobile && !phone.visible ? 'w-full flex-none' : 'flex-1',
      )}
      style={isMobile && !phone.visible ? { aspectRatio: '8 / 5' } : undefined}
      overlay={
        <>
          <PhoneOverlay phone={phone} readOnly={readOnly} attention={attention} />
          {!phone.visible && (
            <div className="absolute inset-x-3 top-3 z-20 rounded bg-navi-black" data-amp-block="">
              <PhoneAttentionNotice attention={attention} lease={phone.snapshot?.lease} />
            </div>
          )}
        </>
      }
    >
      {!phone.visible && !browserEnded && controlState === 'active' && !isUserControlling && (
        <BrowserBorderGlow tone={glowTone} />
      )}
      {!phone.visible && !browserEnded && controlState === 'active' && !isUserControlling && (
        <BrowserCursorOverlay
          agentId={agentId}
          taskId={taskId}
          messages={messages}
          browserUrl={browserUrl}
        />
      )}
      {!phone.visible && !attention.id && !readOnly && !isMobile && controlState === 'active' && (
        <TakeControlChip
          onResume={onResume}
          isResuming={isResuming}
          isUserControlling={isUserControlling}
        />
      )}
      {!phone.visible && !attention.id && !readOnly && !isMobile && controlState === 'waiting' && (
        <WaitingForAssistanceChip
          onResume={onResume}
          isResuming={isResuming}
          request={authAssistanceRequest ?? 'Complete the sign-in so I can continue'}
          isMobile={isMobile}
        />
      )}
      {!phone.visible &&
        !attention.id &&
        !readOnly &&
        !isMobile &&
        controlState === 'disconnected' && (
          <DisconnectedOverlay onResume={onResume} isResuming={isResuming} />
        )}
    </LiveViewFrame>
  );
}
