/**
 * STATE MACHINE: app cover (is the app shell fully hidden behind an opaque overlay?)
 *
 * [UNCOVERED] --coverApp(el): el is opaque and spans the whole viewport--> [COVERED]
 *      ^                                                                      |
 *      +------------------------- uncoverApp() ------------------------------+
 *
 * COVERED: #root gets visibility:hidden (layout, scroll and animation timelines
 * are kept, nothing under the overlay is painted or composited) and subscribers
 * hold their animation loops (AsciiLoader frames, the send button's shader),
 * exactly as they already do for a hidden page. The overlay itself is portaled
 * outside #root, so what is on screen does not change. Uncovering restores
 * #root synchronously, before the overlay's close transition paints.
 *
 * Why: the full-screen mobile drawer covered a chat whose ambient animations
 * (ASCII loader, energy pills under the backdrop blur, shader) kept the
 * renderer and GPU busy for pixels no one could see.
 */

const listeners = new Set<() => void>();
let covered = false;

function setCovered(next: boolean): void {
  if (covered === next) return;
  covered = next;
  const root = document.getElementById('root');
  if (root) root.style.visibility = next ? 'hidden' : '';
  for (const listener of listeners) listener();
}

/** True when `el` paints an opaque box over the entire viewport. */
function coversViewport(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  const alpha = style.backgroundColor.match(/[\d.]+/g)?.[3];
  const image = style.backgroundImage;
  if ((image && image !== 'none') || (alpha !== undefined && Number(alpha) < 1)) return false;
  if (!style.backgroundColor || style.backgroundColor === 'transparent') return false;
  if (style.opacity !== '' && Number(style.opacity) < 1) return false;
  const box = el.getBoundingClientRect();
  return (
    box.left <= 0 &&
    box.top <= 0 &&
    box.right >= window.innerWidth &&
    box.bottom >= window.innerHeight
  );
}

/** Cover the app when `overlay` (rendered outside #root) fully hides it. */
export function coverApp(overlay: HTMLElement | null): void {
  if (!overlay || overlay.closest('#root') || !coversViewport(overlay)) return;
  setCovered(true);
}

export function uncoverApp(): void {
  setCovered(false);
}

export function isAppCovered(): boolean {
  return covered;
}

export function subscribeAppCover(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
