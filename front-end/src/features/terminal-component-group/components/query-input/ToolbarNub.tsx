/**
 * STATE MACHINE: NubTab (Rose Desktop query-box tab; stock UI has no tab)
 *
 * A small tab on the BACK of the query box, flush with its left edge. Its
 * lower 12px sit behind the box and are masked so the Rose gradient wraps the
 * box's 12px top-left curve but never shows through the box.
 *
 *   [CLOSED] 4px lip, 34px wide, strip hidden (opacity 0, no pointer events)
 *      |  pointer enters tab | focus inside | tap/click tab
 *      v
 *   [OPEN]   grows to 18px tall (220ms) and slides sideways to the strip's
 *            width (300ms): lock, context files, budget, context %,
 *            settings, report bug (admin), info — white 12px icons / 10px text, instant tooltips
 *            (no Tools item: the toolset chip is pinned inside the box)
 *      |  pointer leaves (TOOLBAR_LEAVE_GRACE_MS) and focus left and not
 *      |  pinned | tap/click tab again | touch outside
 *      v
 *   [CLOSED]
 *
 * open = hovered || focused || pinned (owned by useToolbarReveal). Clicks on
 * a strip item ([data-nub-item]) or inside its portaled popover/dialog never
 * toggle the pin. The strip stays mounted
 * while closed so its children keep their state (e.g. auto-loaded prompts).
 */

import { useLayoutEffect, useState, type ReactNode } from 'react';
import type { ToolbarReveal } from './useToolbarReveal';

const EASE = 'cubic-bezier(.2,.8,.2,1)';
const CLOSED_HEIGHT = 4;
const OPEN_HEIGHT = 18;
const CLOSED_WIDTH = 34;
/** Box corner radius (rounded-xl); the tab's masked lower part wraps it. */
const BOX_RADIUS = 12;

const ROSE_GRADIENT = 'linear-gradient(120deg,#ffb36b 0%,#ff5f8f 42%,#e43f9a 62%,#9b4dff 100%)';

function useStripWidth(stripRef: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const measure = () => setWidth(strip.scrollWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [stripRef]);
  return width;
}

export function NubTab({ reveal, children }: { reveal: ToolbarReveal; children: ReactNode }) {
  const stripWidth = useStripWidth(reveal.toolbarRef);
  const tabHeight = reveal.open ? OPEN_HEIGHT : CLOSED_HEIGHT;
  const openWidth = Math.max(CLOSED_WIDTH, stripWidth || 300);
  return (
    <div
      ref={reveal.nubRef}
      role="toolbar"
      aria-label="Tools and settings"
      data-testid="query-toolbar-nub"
      data-state={reveal.open ? 'open' : 'closed'}
      {...reveal.regionHandlers}
      onClick={(e) => {
        // Portaled popovers/dialogs bubble clicks here through the React tree;
        // only clicks on the tab itself (not on an item) toggle the pin.
        const target = e.target;
        if (!(target instanceof Node) || !e.currentTarget.contains(target)) return;
        if (target instanceof Element && target.closest('[data-nub-item]')) return;
        reveal.onNubClick();
      }}
      // rose-nub-tab (roseQueryBox.css) = the mask: everything above the box's
      // top edge plus the corner outside its 12px curve, anchored to the tab's
      // bottom so it holds at any height. ::before = invisible hit area above
      // the 4px lip (the painted area is masked).
      className="rose-nub-tab absolute left-0 z-0 cursor-pointer before:absolute before:inset-x-0 before:-top-2.5 before:h-3.5 before:content-['']"
      style={{
        top: -tabHeight,
        height: tabHeight + BOX_RADIUS,
        width: reveal.open ? openWidth : CLOSED_WIDTH,
        borderRadius: '8px 8px 0 0',
        background: ROSE_GRADIENT,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.45)',
        transition: `width 300ms ${EASE}, height 220ms ${EASE}, top 220ms ${EASE}`,
      }}
    >
      <div
        ref={reveal.toolbarRef}
        id={reveal.toolbarId}
        data-testid="query-toolbar-region"
        data-state={reveal.open ? 'open' : 'closed'}
        className="absolute left-0 top-0 flex h-[18px] w-max items-center gap-[10px] whitespace-nowrap px-[10px] text-[10.5px] font-semibold text-white"
        style={{
          opacity: reveal.open ? 1 : 0,
          pointerEvents: reveal.open ? 'auto' : 'none',
          transition: reveal.open ? 'opacity 150ms ease 100ms' : 'opacity 120ms ease',
        }}
      >
        {children}
      </div>
    </div>
  );
}
