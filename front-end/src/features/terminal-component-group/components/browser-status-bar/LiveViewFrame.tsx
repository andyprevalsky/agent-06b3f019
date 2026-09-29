/**
 * LiveViewFrame — letterboxed, chrome-cropped provider live-view iframe.
 *
 * FRAME STATE:
 * [PANE] leftover FE space (flex-1, 60vh, 8:5 reservation, …)
 *   --letterbox--> [STREAM] content viewport 1280/800
 *     --measure clip width-->
 *       --overflow-hidden--> clip Steel window chrome
 *         --cropped iframe--> native 1288x891 canvas,
 *                             translate(-4*s, -91*s) scale(s)
 *                             s = clipWidth/1280 so Amazon cart stays in frame
 *                             Kernel 1280x800 inset-0 (no chrome)
 *
 * The remote browser is never resized from here (antibot / fingerprint-stable
 * session size). Steel session create stays 1288x891.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  resolveLiveViewChromeCrop,
  resolveLiveViewDisplaySize,
  steelLiveViewIframeCropStyle,
  steelLiveViewScaledCropStyle,
} from './liveViewDisplay';

interface LiveViewFrameProps {
  url: string;
  title: string;
  iframeKey?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function LiveViewFrame({
  url,
  title,
  iframeKey,
  className,
  style,
  children,
}: LiveViewFrameProps) {
  const display = resolveLiveViewDisplaySize(url);
  const crop = resolveLiveViewChromeCrop(url);
  const needsClipMeasure = crop !== null;
  const streamRef = useRef<HTMLDivElement>(null);
  const [clipWidth, setClipWidth] = useState(0);
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || !needsClipMeasure) return;
    const update = () => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setClipWidth(width);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [needsClipMeasure]);
  const iframeStyle = crop
    ? clipWidth > 0
      ? steelLiveViewScaledCropStyle(clipWidth)
      : steelLiveViewIframeCropStyle()
    : undefined;
  return (
    <div
      data-testid="live-view-pane"
      className={cn(
        'relative min-h-0 min-w-0 overflow-hidden bg-black [container-type:size]',
        className,
      )}
      style={style}
    >
      <div
        ref={streamRef}
        data-testid="live-view-stream"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden [container-type:size]"
        style={{
          aspectRatio: `${display.width} / ${display.height}`,
          width: `min(100cqw, calc(100cqh * ${display.width} / ${display.height}))`,
          height: `min(100cqh, calc(100cqw * ${display.height} / ${display.width}))`,
        }}
      >
        <iframe
          key={iframeKey ?? `${title}:${url}`}
          src={url}
          title={title}
          className={crop ? 'z-0 border-0' : 'absolute inset-0 z-0 h-full w-full border-0'}
          style={iframeStyle}
          allow="clipboard-read; clipboard-write"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
        />
        {children}
      </div>
    </div>
  );
}
