/**
 * BrowserThumbnail — scaled-down iframe preview used by the minimized/expanded
 * BrowserStatusBar variants. Pure presentational component.
 */

import type { MouseEvent } from 'react';
import { Maximize2 } from 'lucide-react';

export interface BrowserThumbnailProps {
  browserUrl: string;
  /** Outer wrapper dimensions in px. */
  width: number;
  height: number;
  /** Inner iframe dimensions (source viewport being scaled down). */
  iframeWidth: number;
  iframeHeight: number;
  /** CSS scale applied to the iframe. Typically 0.1. */
  scale: number;
  /** Wrapper positioning — BrowserStatusBar overlaps the parent container. */
  wrapperClassName: string;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
}

export function BrowserThumbnail({
  browserUrl,
  width,
  height,
  iframeWidth,
  iframeHeight,
  scale,
  wrapperClassName,
  onClick,
  disabled = false,
}: BrowserThumbnailProps) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      className={wrapperClassName}
      style={{ width: `${width}px`, height: `${height}px`, marginBottom: '8px' }}
    >
      <iframe
        src={browserUrl}
        className="border-0 pointer-events-none"
        style={{
          width: `${iframeWidth}px`,
          height: `${iframeHeight}px`,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
        title="Preview"
      />
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
