/**
 * Smooth-scroll the viewport so the sentinel for `index` is at the
 * top of the scroll band. Picks the first *visible* sentinel when
 * multiple exist (desktop/mobile layouts each render their own set).
 */
export function scrollToFeature(section: HTMLElement | null, index: number): void {
  if (!section) return;

  const all = Array.from(
    section.querySelectorAll(`[data-sentinel-index="${index}"]`),
  ) as HTMLElement[];

  const sentinel =
    all.find((el) => {
      const cs = window.getComputedStyle(el);
      return cs.display !== 'none' && el.offsetParent !== null;
    }) ||
    all[0] ||
    null;

  if (!sentinel) return;

  const rect = sentinel.getBoundingClientRect();
  const targetY = window.scrollY + rect.top + 1;
  try {
    window.scrollTo({ top: targetY, behavior: 'smooth' });
  } catch {
    window.scrollTo(0, targetY);
  }
}
