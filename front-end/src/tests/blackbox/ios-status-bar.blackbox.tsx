/**
 * Blackbox: the installed iOS PWA status bar is opaque (never black-translucent,
 * which iOS 26 blurs) and keeps the app's page color in light and dark.
 * Safe-area padding is env()-driven, so an opaque bar (inset 0) leaves no gap.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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

  it('is non-translucent with a light theme-color default', () => {
    expect(html).toMatch(/apple-mobile-web-app-status-bar-style" content="default"/);
    expect(html).not.toContain('black-translucent');
    expect(html).toContain(`name="theme-color" content="${THEME_COLOR_LIGHT}"`);
    expect(manifest.theme_color).toBe(THEME_COLOR_LIGHT);
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

  it('safe-area inset collapses to 0 when the bar is opaque (no double gap)', () => {
    expect(css).toContain('--safe-area-inset-top: env(safe-area-inset-top, 0px)');
    expect(css).toContain('calc(100% + env(safe-area-inset-top, 0px))');
  });
});
