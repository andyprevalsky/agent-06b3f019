/**
 * STATE MACHINE: themeColor — keeps <meta name="theme-color"> equal to the
 * painted page background so the opaque iOS status bar (standalone, status-bar
 * style "default") matches the app in light and dark.
 *
 * [IDLE] --initThemeColorSync()--> [SYNCED] (meta set from html.dark)
 * [SYNCED] --html class mutation--> [SYNCED] (meta re-set; no-op if unchanged)
 *
 * Rose Desktop theming is class-based (html.dark), not prefers-color-scheme,
 * so a media-attribute meta cannot follow the in-app toggle.
 */

export const THEME_COLOR_LIGHT = '#f9f9fb'; // hsl(240 15% 98%) page
export const THEME_COLOR_DARK = '#272725'; // html.dark page

function ensureMeta(): HTMLMetaElement {
  const existing = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (existing) return existing;
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  document.head.appendChild(meta);
  return meta;
}

export function syncThemeColor(): void {
  const meta = ensureMeta();
  const color = document.documentElement.classList.contains('dark')
    ? THEME_COLOR_DARK
    : THEME_COLOR_LIGHT;
  if (meta.content !== color) meta.content = color;
}

export function initThemeColorSync(): () => void {
  syncThemeColor();
  const observer = new MutationObserver(syncThemeColor);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
