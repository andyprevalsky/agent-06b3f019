/**
 * Blur lab effects: pure DOM helpers. Each effect returns a revert function.
 * Nothing here runs unless the lab was activated (see activateBlurLab).
 */

const STORAGE_KEY = 'rose.blurlab';
const STATUS_META = 'meta[name="apple-mobile-web-app-status-bar-style"]';

/** Lab is on when the URL has ?blurlab=1 (then remembered for the session). */
export function shouldActivateBlurLab(): boolean {
  if (typeof window === 'undefined') return false;
  const api = (window as typeof window & { api?: { isElectron?: boolean } }).api;
  if (api?.isElectron === true) return false;
  try {
    if (new URLSearchParams(window.location.search).get('blurlab') === '1') {
      window.sessionStorage.setItem(STORAGE_KEY, '1');
      return true;
    }
    return window.sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function injectCss(id: string, css: string): () => void {
  const el = document.createElement('style');
  el.setAttribute('data-blurlab', id);
  el.textContent = css;
  document.head.appendChild(el);
  return () => el.remove();
}

export interface CssEffect {
  id: string;
  label: string;
  css: string;
}

export const CSS_EFFECTS: readonly CssEffect[] = [
  {
    id: 'header-opaque',
    label: 'Force top fixed/sticky bg opaque #1c1c1c',
    css: 'header,[data-blurlab-top]{background-color:#1c1c1c !important}',
  },
  {
    id: 'header-transparent',
    label: 'Force top fixed/sticky bg transparent',
    css: 'header,[data-blurlab-top]{background-color:transparent !important}',
  },
  {
    id: 'no-backdrop',
    label: 'backdrop-filter: none everywhere',
    css: '*,*::before,*::after{-webkit-backdrop-filter:none !important;backdrop-filter:none !important}',
  },
  {
    id: 'no-mask-filter',
    label: 'mask-image + filter: none everywhere',
    css: '*,*::before,*::after{-webkit-mask-image:none !important;mask-image:none !important;filter:none !important}',
  },
  {
    id: 'pos-absolute',
    label: 'Top fixed -> position: absolute',
    css: '[data-blurlab-top]{position:absolute !important}',
  },
  {
    id: 'pos-sticky',
    label: 'Top fixed -> position: sticky',
    css: '[data-blurlab-top]{position:sticky !important;top:0 !important}',
  },
  {
    id: 'bg-solid',
    label: 'html/body bg solid #1c1c1c',
    css: 'html,body{background-color:#1c1c1c !important}',
  },
  {
    id: 'bg-transparent',
    label: 'html/body bg transparent',
    css: 'html,body{background-color:transparent !important}',
  },
  {
    id: 'bg-layers',
    label: 'Hide grid / ASCII background layers',
    css: 'canvas,[class*="grid"],[class*="ascii"],[data-testid*="grid"],[data-testid*="ascii"],[data-testid*="background"]{visibility:hidden !important}',
  },
];

export const STATUS_STYLES = ['default', 'black', 'black-translucent'] as const;

/** Sets the status-bar meta. iOS reads it at launch: relaunch / re-add may be needed. */
export function setStatusBarStyle(value: string): () => void {
  let meta = document.querySelector<HTMLMetaElement>(STATUS_META);
  const created = !meta;
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'apple-mobile-web-app-status-bar-style';
    document.head.appendChild(meta);
  }
  const previous = meta.content;
  meta.content = value;
  return () => {
    if (created) meta.remove();
    else meta.content = previous;
  };
}

export interface TopElement {
  el: HTMLElement;
  label: string;
}

function describe(el: HTMLElement): string {
  const id = el.id ? `#${el.id}` : '';
  const tid = el.getAttribute('data-testid');
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
  return `${el.tagName.toLowerCase()}${id}${tid ? `[${tid}]` : ''}${cls ? `.${cls.slice(0, 24)}` : ''}`;
}

/** Fixed/sticky elements touching the top band; tagged so CSS effects can target them. */
export function findTopElements(limit = 80): TopElement[] {
  const found: TopElement[] = [];
  document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
    if (el.closest('[data-blurlab-panel]')) return;
    const position = getComputedStyle(el).position;
    if (position !== 'fixed' && position !== 'sticky') return;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0 || rect.top > limit || rect.bottom <= 0) return;
    el.setAttribute('data-blurlab-top', '');
    found.push({ el, label: describe(el) });
  });
  return found;
}

export function hideElement(el: HTMLElement): () => void {
  const previous = el.style.visibility;
  el.style.visibility = 'hidden';
  return () => {
    el.style.visibility = previous;
  };
}

/** Computed styles of everything intersecting the top band, as text. */
export function topBandReport(limit = 80): string {
  const props = [
    'position',
    'top',
    'height',
    'background-color',
    'background-image',
    'backdrop-filter',
    '-webkit-backdrop-filter',
    'filter',
    'mask-image',
    'opacity',
    'transform',
    'z-index',
    'overflow-y',
  ];
  const lines: string[] = [
    `ua: ${navigator.userAgent}`,
    `standalone: ${String((navigator as Navigator & { standalone?: boolean }).standalone)}`,
    `inner: ${window.innerWidth}x${window.innerHeight} vv: ${window.visualViewport?.height ?? '?'}`,
    `status-style: ${document.querySelector<HTMLMetaElement>(STATUS_META)?.content ?? 'none'}`,
    `theme-color: ${document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? 'none'}`,
    `scrollY: ${window.scrollY}`,
  ];
  document.querySelectorAll<HTMLElement>('html, body, body *').forEach((el) => {
    if (el.closest('[data-blurlab-panel]')) return;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 || rect.top >= limit || rect.bottom <= 0) return;
    const cs = getComputedStyle(el);
    const interesting = props
      .map((p) => [p, cs.getPropertyValue(p)] as const)
      .filter(([, v]) => v && !['none', 'auto', 'normal', '0px', 'static', '1'].includes(v))
      .map(([p, v]) => `${p}=${v.slice(0, 60)}`);
    lines.push(
      `${describe(el)} @${Math.round(rect.top)}..${Math.round(rect.bottom)} ${interesting.join('; ')}`,
    );
  });
  return lines.join('\n');
}
