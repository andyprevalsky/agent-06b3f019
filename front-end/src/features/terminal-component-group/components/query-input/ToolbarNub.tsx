/**
 * STATE MACHINE: ToolbarNub (query-box toolbar reveal)
 *
 * The query box's top toolbar (Safe Writes, tools, cost, context, settings) is
 * hidden behind a small rose-gradient nub at the box's top-left corner.
 *
 *   [COLLAPSED] --pointer enters nub | focus nub/toolbar | tap/Enter nub--> [EXPANDED]
 *   [EXPANDED]  --pointer over toolbar---------------------------------> [EXPANDED]
 *   [EXPANDED]  --pointer leaves nub+toolbar (LEAVE_GRACE_MS) and
 *                 focus left both and not pinned------------------------> [COLLAPSED]
 *   [EXPANDED/pinned] --tap/Enter nub again | touch outside------------> [COLLAPSED]
 *
 * open = hovered || focused || pinned.
 *   hovered : mouse/pen pointer is over the nub or the toolbar (touch ignored,
 *             so emulated touch hovers can't hold the toolbar open).
 *   focused : keyboard focus is on the nub or inside the toolbar (including
 *             portaled popovers, which bubble through the React tree).
 *   pinned  : toggled by a non-mouse click (touch tap or keyboard Enter/Space).
 *
 * Collapse/expand animates max-height + opacity over 280ms
 * cubic-bezier(.2,.8,.2,1). The toolbar stays mounted while collapsed so its
 * children keep their state (e.g. auto-loaded test prompts).
 */

import { cn } from '@/lib/utils';
import type { ToolbarReveal } from './useToolbarReveal';

const REVEAL_EASE = 'cubic-bezier(.2,.8,.2,1)';

const NUB_STYLE: React.CSSProperties = {
  background: 'linear-gradient(120deg,#ffb36b 0%,#ff5f8f 42%,#e43f9a 62%,#9b4dff 100%)',
  transition: `width 280ms ${REVEAL_EASE}, box-shadow 280ms ${REVEAL_EASE}`,
};

const NUB_SHADOW =
  'inset 0 1px 0 rgba(255,255,255,.65), inset 0 -1px 1px rgba(80,0,60,.25), 0 2px 8px rgba(255,80,140,.45), 0 0 0 .5px rgba(255,255,255,.6)';
const NUB_SHADOW_OPEN =
  'inset 0 1px 0 rgba(255,255,255,.7), 0 3px 14px rgba(255,80,140,.6), 0 0 0 .5px rgba(255,255,255,.7)';

/** The 30×9 rose-gradient nub at the query box's top-left corner (7px inset). */
export function ToolbarNub({ reveal }: { reveal: ToolbarReveal }) {
  return (
    <button
      ref={reveal.nubRef}
      type="button"
      data-testid="query-toolbar-nub"
      aria-label="Tools and settings"
      title="Tools & settings"
      aria-expanded={reveal.open}
      aria-controls={reveal.toolbarId}
      onClick={reveal.onNubClick}
      {...reveal.regionHandlers}
      className={cn(
        'absolute left-[7px] top-[7px] z-30 h-[9px] cursor-pointer rounded-full p-0',
        // Highlight streak along the top edge of the pill.
        "after:pointer-events-none after:absolute after:left-1 after:right-1 after:top-px after:h-[3px] after:rounded-full after:bg-gradient-to-b after:from-white/75 after:to-white/0 after:content-['']",
        // Invisible larger hit area for touch; no visual change.
        "before:absolute before:-inset-2 before:content-['']",
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#ff5f8f]/60',
        reveal.open ? 'w-[44px]' : 'w-[30px]',
      )}
      style={{ ...NUB_STYLE, boxShadow: reveal.open ? NUB_SHADOW_OPEN : NUB_SHADOW }}
    />
  );
}

/**
 * Collapsible container for the toolbar row; hidden until the nub opens it.
 * Without a reveal (standalone TopBar renders) the row is always shown.
 */
export function ToolbarRevealRegion({
  reveal,
  children,
}: {
  reveal?: ToolbarReveal;
  children: React.ReactNode;
}) {
  if (!reveal) return <>{children}</>;
  return (
    <div
      ref={reveal.toolbarRef}
      id={reveal.toolbarId}
      data-testid="query-toolbar-region"
      data-state={reveal.open ? 'open' : 'closed'}
      {...reveal.regionHandlers}
      className={cn(reveal.open ? 'overflow-visible' : 'pointer-events-none overflow-hidden')}
      style={{
        maxHeight: reveal.open ? 60 : 0,
        opacity: reveal.open ? 1 : 0,
        transition: `max-height 280ms ${REVEAL_EASE}, opacity 200ms ease`,
      }}
    >
      {children}
    </div>
  );
}
