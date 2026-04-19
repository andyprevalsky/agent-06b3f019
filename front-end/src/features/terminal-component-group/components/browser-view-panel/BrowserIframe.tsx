import { useRef } from 'react';
import { cn } from '@/lib/utils';
import BrowserBorderGlow from '../BrowserBorderGlow';
import BrowserCursorOverlay from '../BrowserCursorOverlay';
import { StatusOverlay } from './StatusOverlay';
import type { Message } from '../../hooks';

interface BrowserIframeProps {
  taskId: string;
  url: string;
  messages: Message[];
  isFullscreen: boolean;
  isDisconnected: boolean;
  isResuming: boolean;
  onResume: () => void;
}

export function BrowserIframe({
  taskId,
  url,
  messages,
  isFullscreen,
  isDisconnected,
  isResuming,
  onResume,
}: BrowserIframeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  return (
    <div
      className={cn(
        'bg-white border-x border-b border-border w-full relative',
        isFullscreen ? 'flex-1' : 'aspect-video',
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

      <BrowserBorderGlow />
      <BrowserCursorOverlay taskId={taskId} messages={messages} />

      {isDisconnected && <StatusOverlay isResuming={isResuming} onResume={onResume} />}
    </div>
  );
}
