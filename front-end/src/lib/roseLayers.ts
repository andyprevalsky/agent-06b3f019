/**
 * Rose Desktop stacking order: the ONE z scale for layers that compete at the
 * page root. Every layer below is `fixed` and portaled to document.body. An
 * element left inside the main row (TerminalContent's `z-[4]` flex item, its
 * own stacking context) can never paint above any of them, whatever its z.
 * Lowest first:
 *
 *   page content   main row z-[4]: chat column, in-flow chrome
 *   appPanel       right app panels that sit beside the composer
 *                  (Feedback, Benchmarks, Settings) and the floating Phone
 *   left bar       collapsed z-[70] (RoseSidebar)
 *   appIcons       top-right app icons, over an appPanel's corner
 *   composer       the floating query box (QueryInputLayer) and the
 *                  agents-running pane attached to its top
 *   leftPanel      project settings beside the left bar; covers the composer
 *                  but stays open under an app the user opens afterwards
 *   coverPanel     app panels that cover the composer: Browser, Integrations
 *                  and Biz health (right / full width)
 *   coverIcons     top-right app icons, over a coverPanel's corner
 *   left bar       hover-expanded z-[110] (RoseSidebar), over a full panel
 *   modal          ui/dialog (scrim 200 < content 201) and ui/sheet (scrim
 *                  210 < panel 211, e.g. the file viewer). Never give modal
 *                  content a z below its own scrim.
 *   popover        popovers opened from any layer above (ui/popover), e.g.
 *                  the composer's Rose toolset
 *
 * Full class strings so Tailwind's content scan generates them.
 */
export const ROSE_LAYER = {
  appPanel: 'z-[66]',
  appIcons: 'z-[90]',
  composer: 'z-[100]',
  leftPanel: 'z-[101]',
  coverPanel: 'z-[102]',
  coverIcons: 'z-[103]',
  popover: 'z-[220]',
} as const;
