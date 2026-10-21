/** Keep the composer at its layout position while escaping the app panel stacking context. */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Geometry = { left: number; top: number; width: number; height: number };

export function QueryInputLayer({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  useLayoutEffect(() => {
    if (!enabled) return;
    const update = () => {
      if (!anchor.current || !layer.current) return;
      const bounds = anchor.current.getBoundingClientRect();
      const height = layer.current.getBoundingClientRect().height;
      setGeometry((previous) => {
        const next = { left: bounds.left, top: bounds.top, width: bounds.width, height };
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
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [enabled]);

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
          ref={layer}
          data-testid="query-input-layer"
          className="fixed z-[100] flow-root rose-mobile-query-area"
          style={{
            left: geometry?.left ?? 0,
            top: geometry?.top ?? 0,
            width: geometry?.width || '100%',
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
