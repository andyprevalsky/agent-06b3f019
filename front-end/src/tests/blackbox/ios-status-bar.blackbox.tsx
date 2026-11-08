/**
 * Blackbox: the installed iOS PWA status bar is opaque (never black-translucent,
 * which iOS 26 blurs) and keeps the app's page color in light and dark.
 * Safe-area padding is env()-driven, so an opaque bar (inset 0) leaves no gap.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RoseThemeProvider } from '@/features/rose-theme';

import { COVER_LAYER_CSS } from '@/dev/blur-lab/blurLabEffects';
import { THEME_COLOR_DARK, THEME_COLOR_LIGHT, initThemeColorSync } from '@/lib/themeColor';

const root = resolve(__dirname, '../../..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(root, 'public/site.webmanifest'), 'utf8'));
const css = readFileSync(resolve(root, 'src/index.css'), 'utf8');

describe('iOS standalone status bar', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
    document.querySelector('meta[name="theme-color"]')?.remove();
  });

  it('is opaque default style (never black or black-translucent) with a light theme-color default', () => {
    expect(html).toMatch(/apple-mobile-web-app-status-bar-style" content="default"/);
    expect(html).not.toMatch(/status-bar-style" content="black/);
    expect(html).not.toMatch(/<meta[^>]*status-bar-style"[^>]*black-translucent/);
    expect(html).toContain(`name="theme-color" content="${THEME_COLOR_LIGHT}"`);
    expect(manifest.theme_color).toBe(THEME_COLOR_DARK);
    expect(manifest.background_color).toBe(THEME_COLOR_DARK);
  });

  it('theme-color matches the page background tokens', () => {
    expect(css).toContain('--background: 240 15% 98%'); // #f9f9fb
    expect(css).toContain('--background: 60 2.6% 14.9%; /* #272725 page */');
  });

  it('theme-color follows html.dark', async () => {
    const stop = initThemeColorSync();
    const meta = () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
    expect(meta().content).toBe(THEME_COLOR_LIGHT);
    document.documentElement.classList.add('dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(meta().content).toBe(THEME_COLOR_DARK);
    document.documentElement.classList.remove('dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(meta().content).toBe(THEME_COLOR_LIGHT);
    stop();
  });

  it('pre-paint script sets html.dark + theme-color from the stored dark choice', () => {
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .find((body) => body.includes('rose-theme:'))!;
    const run = () => new Function(script)();
    document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" content="#f9f9fb">');
    window.localStorage.setItem('rose-theme:u1', 'light');
    run();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    window.localStorage.setItem('rose-theme:u1', 'dark');
    run();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(
      THEME_COLOR_DARK,
    );
    // Cookie backup alone (storage wiped) still yields dark.
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.cookie = 'rose-theme%3Au1=dark; Path=/';
    run();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    document.cookie = 'rose-theme%3Au1=; Max-Age=0; Path=/';
    document.documentElement.removeAttribute('data-rose-predark');
  });

  it('pre-paint script prefers the last-active account on a mixed device', () => {
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .find((body) => body.includes('rose-theme:'))!;
    const run = () => new Function(script)();
    const root = document.documentElement;
    document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" content="#f9f9fb">');
    window.localStorage.setItem('rose-theme:dark-user', 'dark');
    window.localStorage.setItem('rose-theme:light-user', 'light');
    window.localStorage.setItem('rose-theme-active', 'light-user');
    run();
    expect(root.classList.contains('dark')).toBe(false);
    window.localStorage.setItem('rose-theme-active', 'dark-user');
    run();
    expect(root.classList.contains('dark')).toBe(true);
    root.classList.remove('dark');
    window.localStorage.setItem('rose-theme-active', 'stock-user'); // nothing stored: light
    run();
    expect(root.classList.contains('dark')).toBe(false);
    window.localStorage.clear();
    root.removeAttribute('data-rose-predark');
  });

  it('provider records the active account and clears a stale pre-paint dark for light accounts', () => {
    const root = document.documentElement;
    root.classList.add('dark');
    root.setAttribute('data-rose-predark', '');
    window.localStorage.setItem('rose-theme:light-user', 'light');
    const view = render(<RoseThemeProvider userId="light-user">x</RoseThemeProvider>);
    expect(window.localStorage.getItem('rose-theme-active')).toBe('light-user');
    expect(root.classList.contains('dark')).toBe(false);
    view.unmount();
    window.localStorage.clear();
  });

  it('safe-area inset collapses to 0 when the bar is opaque (no double gap)', () => {
    expect(css).toContain('--safe-area-inset-top: env(safe-area-inset-top, 0px)');
    expect(css).toContain('calc(100% + env(safe-area-inset-top, 0px))');
    // cover layer height and header padding both use the same inset token
    expect(COVER_LAYER_CSS).toContain('height:env(safe-area-inset-top,0px)');
  });
});
