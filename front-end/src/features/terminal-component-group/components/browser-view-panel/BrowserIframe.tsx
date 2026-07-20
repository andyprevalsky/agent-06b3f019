/**
 * STATE MACHINE: BrowserIframe
 *
 * [ACTIVE]
 *   - iframe + BrowserBorderGlow + BrowserCursorOverlay
 *
 * [WAITING_FOR_AUTH_ASSISTANCE]
 *   - iframe + blurred Start Agent overlay
 *   - no active-agent glow/cursor indicators
 *
 * [DISCONNECTED]
 *   - iframe + blurred Take Control overlay
 *
 * SIZING:
 *   fullscreen -> flex-1 (fills the fullscreen column)
 *   inline desktop -> aspect-video (16:9)
 *   inline mobile -> h-[60vh] (a fixed 16:9 letterbox is a tiny sliver on a
 *     narrow portrait phone, so use available viewport height instead)
 */

import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import BrowserBorderGlow from '../BrowserBorderGlow';
import BrowserCursorOverlay from '../BrowserCursorOverlay';
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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const isMobile = useIsMobile();

  return (
    <div
      className={cn(
        'bg-white border-x border-b border-border w-full relative',
        isFullscreen ? 'flex-1' : isMobile ? 'h-[60vh]' : 'aspect-video',
      )}
    >
      <iframe
        ref={iframeRef}
        src={url}
        className="w-full h-full border-0 absolute inset-0 z-0"
        allow="clipboard-read; clipboard-write"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
        title="Browser Session"
      />

      {!isWaitingForAuthAssistance && <BrowserBorderGlow />}
      {!isWaitingForAuthAssistance && (
        <BrowserCursorOverlay agentId={agentId} taskId={taskId} messages={messages} />
      )}

      {isDisconnected && !isWaitingForAuthAssistance && (
        <StatusOverlay isResuming={isResuming} onResume={onResume} />
      )}
      {isWaitingForAuthAssistance && (
        <StatusOverlay
          isResuming={isResuming}
          onResume={onResume}
          buttonLabel="Start Agent"
          loadingLabel="Loading..."
        />
      )}
    </div>
  );
}
