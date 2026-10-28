/**
 * BrowserThumbnail — scaled-down iframe preview used by the minimized/expanded
 * BrowserStatusBar variants. Pure presentational component.
 *
 * Frames the content viewport (1280x800). Steel streams are the 1288x891
 * computer window, so the iframe is translated to hide toolbar/borders.
 * A compact LiveViewLoading covers the iframe until its URL loads; a finished
 * agent (ended) shows LiveViewEnded instead and never mounts the iframe.
 */

import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import { Maximize2 } from 'lucide-react';
import {
  computeCroppedLiveViewIframe,
  computeLiveViewLetterbox,
  resolveLiveViewChromeCrop,
  resolveLiveViewDisplaySize,
  resolveLiveViewWindowSize,
} from './liveViewDisplay';
import { LiveViewEnded, LiveViewLoading } from './LiveViewLoading';
import { useLiveViewLoaded } from './useLiveViewLoaded';

export interface BrowserThumbnailProps {
  browserUrl: string;
  /** False when the bound session is closed or ended: loading, no iframe. */
  live?: boolean;
  /** Owning agent finished: terminal "ended" state, no iframe, no loading. */
  ended?: boolean;
  /** Outer wrapper dimensions in px. */
  width: number;
  height: number;
  /** Wrapper positioning — BrowserStatusBar overlaps the parent container. */
  wrapperClassName: string;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
}

export function BrowserThumbnail({
  browserUrl,
  live = true,
  ended = false,
  width,
  height,
  wrapperClassName,
  onClick,
  disabled = false,
}: BrowserThumbnailProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { isLoaded, onLoad } = useLiveViewLoaded(browserUrl);
  useLayoutEffect(() => {
    iframeRef.current?.setAttribute('inert', '');
  }, [live, browserUrl]);
  const display = resolveLiveViewDisplaySize(browserUrl);
  const windowSize = resolveLiveViewWindowSize(browserUrl);
  const crop = resolveLiveViewChromeCrop(browserUrl);
  const clip = computeLiveViewLetterbox(width, height, display.width, display.height);
  const iframe = crop
    ? computeCroppedLiveViewIframe(clip, crop)
    : {
        width: windowSize.width,
        height: windowSize.height,
        x: clip.offsetX,
        y: clip.offsetY,
        scale: clip.scale,
      };
  return (
    <div
      onClick={disabled ? undefined : onClick}
      className={wrapperClassName}
      style={{ width: `${width}px`, height: `${height}px`, marginBottom: '8px' }}
    >
      {live && !ended && (
        <iframe
          ref={iframeRef}
          src={browserUrl}
          className="border-0 pointer-events-none"
          tabIndex={-1}
          style={{
            width: `${iframe.width}px`,
            height: `${iframe.height}px`,
            transform: `translate(${iframe.x}px, ${iframe.y}px) scale(${iframe.scale})`,
            transformOrigin: 'top left',
          }}
          title="Preview"
          onLoad={onLoad}
        />
      )}
      {ended ? <LiveViewEnded compact /> : (!live || !isLoaded) && <LiveViewLoading compact />}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-black/10 to-black/30 opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="pointer-events-none absolute bottom-1 right-1 flex items-center gap-1 rounded-md bg-black/70 text-white px-2 py-1 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
        <Maximize2 className="h-3.5 w-3.5" />
        <span>Expand</span>
      </div>
      <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground text-background px-2 py-1 text-xs opacity-0 group-hover:opacity-100 transition-opacity z-50">
        See Agent Computer
      </div>
    </div>
  );
}
