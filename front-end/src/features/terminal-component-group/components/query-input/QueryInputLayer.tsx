/**
 * Keep the composer at its layout position while escaping the app panel stacking context.
 *
 * The fixed layer is pinned by its BOTTOM edge to the anchor's bottom (the
 * composer sits at the bottom of a bottom-aligned column), so content that
 * grows inside it (the agents-running pane opening) extends upward in the same
 * frame. Pinned by top, it grew downward past its slot for the ~2 frames the
 * ResizeObserver -> anchor height -> anchor position round trip took, then
 * jumped up (and the reverse on close).
 *
 * The layer is placed inside a fixed full-viewport frame by the difference
 * between the frame's and the anchor's client rects. Both rects share one
 * coordinate space, so the offset holds however the browser maps client to
 * fixed coordinates: with the iOS keyboard up, client rects follow the panned
 * visual viewport while fixed boxes keep the layout viewport, and the old
 * `clientHeight - anchor.bottom` placed the composer one pan (~335pt) above
 * its slot, over the top of the chat.
 *
 * The Rose left bar pinning or unpinning shifts the column without resizing
 * it, so ROSE_BAR_OFFSET_EVENT also triggers a re-measure.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useRoseApps } from '../rose-apps/roseAppsState';
import { createPortal } from 'react-dom';
import { ROSE_LAYER } from '@/lib/roseLayers';
import { browserComposerTarget } from './browserComposer';
import { ROSE_BAR_OFFSET_EVENT } from '../rose-sidebar/roseSidebarLayout';

type Geometry = { left: number; bottom: number; width: number; height: number };

export function QueryInputLayer({
  enabled,
  children,
  ownerAgentId,
}: {
  enabled: boolean;
  children: ReactNode;
  ownerAgentId?: string;
}) {
  const apps = useRoseApps();
  const browserOpen = apps?.openApp === 'browser';
  const raised = enabled && !browserOpen;
  const anchor = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  useLayoutEffect(() => {
    if (!raised) return;
    const update = () => {
      if (!anchor.current || !frame.current || !layer.current) return;
      const bounds = anchor.current.getBoundingClientRect();
      const viewport = frame.current.getBoundingClientRect();
      const height = layer.current.getBoundingClientRect().height;
      setGeometry((previous) => {
        const next = {
          left: bounds.left - viewport.left,
          bottom: viewport.bottom - bounds.bottom,
          width: bounds.width,
          height,
        };
        return previous &&
          Object.keys(next).every(
            (key) => previous[key as keyof Geometry] === next[key as keyof Geometry],
          )
          ? previous
          : next;
      });
    };
    update();
    const observer = new ResizeObserver(update);
    if (anchor.current) {
      observer.observe(anchor.current);
      // Gate/status rows can move the anchor without changing its own size.
      const parent = anchor.current.parentElement;
      if (parent) observer.observe(parent);
      if (parent?.parentElement) observer.observe(parent.parentElement);
    }
    if (layer.current) observer.observe(layer.current);
    window.addEventListener('resize', update);
    window.addEventListener(ROSE_BAR_OFFSET_EVENT, update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener(ROSE_BAR_OFFSET_EVENT, update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [raised]);

  if (enabled && browserOpen) {
    const target = browserComposerTarget(apps, ownerAgentId);
    // Preserve the existing send/stop channel; only move it into its selected owner's pane.
    if (!target) return null;
    return createPortal(
      <div
        data-testid="browser-query-input"
        className="[&_[data-testid=query-input-host]]:mt-0 [&_textarea]:!max-h-[96px] [&_textarea]:!min-h-[40px]"
      >
        {children}
      </div>,
      target,
    );
  }
  if (!enabled) return <>{children}</>;
  return (
    <>
      <div
        ref={anchor}
        data-testid="query-layer-anchor"
        className="w-full shrink-0"
        style={{ height: geometry?.height ?? 0 }}
      />
      {createPortal(
        <div
          ref={frame}
          data-testid="query-input-frame"
          className={`pointer-events-none fixed inset-0 ${ROSE_LAYER.composer}`}
        >
          <div
            ref={layer}
            data-testid="query-input-layer"
            className="pointer-events-auto absolute flow-root rose-mobile-query-area"
            style={{
              left: geometry?.left ?? 0,
              bottom: geometry?.bottom ?? 0,
              width: geometry?.width || '100%',
            }}
          >
            {children}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
