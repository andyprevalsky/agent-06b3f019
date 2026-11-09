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
 *                             Kernel native 1280x800, scale(s) (its player
 *                             never upscales; Chrome UI stays visible)
 *                             Tilion viewer page inset-0 (page-only stream)
 *
 * PHONE OVERLAY: active/queued -> root overlay blocks the mounted browser; release -> same iframe.
 *
 * LOAD STATE: [LOADING] (LiveViewLoading covers the iframe)
 *   --iframe load for this url--> [STREAMING]; a new url restarts at LOADING.
 *   live=false (bound session closed/ended) --> [NOT_LIVE] LiveViewLoading and
 *   no iframe, so a provider "session closed" page is never shown.
 *   ended=true (owning agent finished) --> [ENDED] LiveViewEnded, no iframe.
 *
 * INPUT STATE: interactive=true -> the provider viewer receives real mouse
 *   and keyboard (Tilion /live-view sends them as page input);
 *   interactive=false -> inert + pointer-events-none + tabIndex -1.
 *
 * The remote browser is never resized from here (antibot / fingerprint-stable
 * session size). Steel session create stays 1288x891.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  isKernelLiveViewUrl,
  kernelLiveViewIframeStyle,
  kernelLiveViewScaledStyle,
  presentLiveViewIframeUrl,
  resolveLiveViewChromeCrop,
  resolveLiveViewDisplaySize,
  steelLiveViewIframeCropStyle,
  steelLiveViewScaledCropStyle,
} from './liveViewDisplay';
import { LiveViewEnded, LiveViewLoading } from './LiveViewLoading';
import { useLiveViewLoaded } from './useLiveViewLoaded';

interface LiveViewFrameProps {
  url: string;
  /** False when the bound session is closed or ended. */
  live?: boolean;
  /** Owning agent finished: [ENDED] terminal state, no iframe, never "Connecting…". */
  ended?: boolean;
  title: string;
  /** The provider viewer may itself accept input; gate it while the agent owns control. */
  interactive?: boolean;
  iframeKey?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  overlay?: ReactNode;
}

export function LiveViewFrame({
  url,
  live = true,
  ended = false,
  title,
  interactive = true,
  iframeKey,
  className,
  style,
  children,
  overlay,
}: LiveViewFrameProps) {
  const display = resolveLiveViewDisplaySize(url);
  const crop = resolveLiveViewChromeCrop(url);
  const kernel = crop === null && isKernelLiveViewUrl(url);
  const needsClipMeasure = crop !== null || kernel;
  const streamRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [clipWidth, setClipWidth] = useState(0);
  const { isLoaded, onLoad } = useLiveViewLoaded(url);
  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (interactive) iframe.removeAttribute('inert');
    else iframe.setAttribute('inert', '');
    // A new url/key or a live toggle mounts a fresh iframe that needs the attribute too.
  }, [interactive, live, iframeKey, url]);
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
  let iframeStyle: CSSProperties | undefined;
  if (crop) {
    iframeStyle =
      clipWidth > 0 ? steelLiveViewScaledCropStyle(clipWidth) : steelLiveViewIframeCropStyle();
  } else if (kernel) {
    iframeStyle =
      clipWidth > 0 ? kernelLiveViewScaledStyle(clipWidth) : kernelLiveViewIframeStyle();
  }
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
        {live && !ended && (
          <iframe
            ref={iframeRef}
            key={iframeKey ?? `${title}:${url}`}
            src={presentLiveViewIframeUrl(url)}
            title={title}
            className={cn(
              iframeStyle ? 'z-0 border-0' : 'absolute inset-0 z-0 h-full w-full border-0',
              !interactive && 'pointer-events-none',
            )}
            style={iframeStyle}
            tabIndex={interactive ? undefined : -1}
            allow="clipboard-read; clipboard-write"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            onLoad={onLoad}
          />
        )}
        {ended ? <LiveViewEnded /> : (!live || !isLoaded) && <LiveViewLoading />}
        {children}
      </div>
      {overlay}
    </div>
  );
}
