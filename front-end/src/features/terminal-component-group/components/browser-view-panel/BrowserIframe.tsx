/**
 * STATE MACHINE: BrowserIframe
 *
 * [ACTIVE]
 *   - iframe + BrowserBorderGlow + BrowserCursorOverlay
 *   - glow tone=default (blue) | tone=challenge_recovery (orange) while
 *     recover_from_challenge progress messages are IN_PROGRESS
 *
 * [WAITING_FOR_AUTH_ASSISTANCE]
 *   - interactive iframe + compact Start Agent button
 *   - no active-agent glow/cursor indicators
 *
 * [DISCONNECTED]
 *   - iframe + blurred Take Control overlay
 *
 * SIZING:
 *   fullscreen -> flex-1 letterboxed LiveViewFrame (content 1280/800)
 *   inline desktop -> LiveViewFrame at content 1280/800 (Steel chrome cropped)
 *   inline mobile -> h-[60vh] letterboxed LiveViewFrame
 */

import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import BrowserBorderGlow from '../BrowserBorderGlow';
import { resolveBrowserBorderGlowTone } from '../browserBorderGlow/resolveTone';
import BrowserCursorOverlay from '../BrowserCursorOverlay';
import { resolveBrowserControlState } from '../browserControlState';
import { LiveViewFrame } from '../browser-status-bar/BrowserLiveViewFrame';
import { resolveLiveViewDisplaySize } from '../browser-status-bar/liveViewDisplay';
import { StatusOverlay } from './StatusOverlay';
import type { Message } from '../../hooks';

interface BrowserIframeProps {
  agentId?: string | null;
  taskId: string;
  url: string;
  messages: Message[];
  isFullscreen: boolean;
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
  isResuming: boolean;
  onResume: () => void;
}

export function BrowserIframe({
  agentId,
  taskId,
  url,
  messages,
  isFullscreen,
  isDisconnected,
  isWaitingForAuthAssistance,
  isResuming,
  onResume,
}: BrowserIframeProps) {
  const isMobile = useIsMobile();
  const controlState = resolveBrowserControlState({
    isDisconnected,
    isWaitingForAuthAssistance,
  });
  const glowTone = resolveBrowserBorderGlowTone(messages, taskId);
  const stream = resolveLiveViewDisplaySize(url);

  return (
    <LiveViewFrame
      url={url}
      title="Browser Session"
      interactive={controlState === 'waiting'}
      className={cn(
        'border-x border-b border-border bg-white',
        isFullscreen ? 'flex-1' : isMobile ? 'h-[60vh]' : 'w-full',
      )}
      style={
        !isFullscreen && !isMobile
          ? { aspectRatio: `${stream.width} / ${stream.height}` }
          : undefined
      }
    >
      {controlState === 'active' && <BrowserBorderGlow tone={glowTone} />}
      {controlState === 'active' && (
        <BrowserCursorOverlay agentId={agentId} taskId={taskId} messages={messages} />
      )}

      {controlState === 'disconnected' && (
        <StatusOverlay isResuming={isResuming} onResume={onResume} />
      )}
      {controlState === 'waiting' && (
        <StatusOverlay
          isResuming={isResuming}
          onResume={onResume}
          buttonLabel="Start Agent"
          loadingLabel="Loading..."
          compact
        />
      )}
    </LiveViewFrame>
  );
}
