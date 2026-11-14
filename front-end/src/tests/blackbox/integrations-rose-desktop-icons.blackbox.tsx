/**
 * Rose Desktop integrations (flag on), UI ledger rows 68/85: the stock
 * app-icon tiles (DropdownIconFrame + MessageSyncIcons: iMessage's green
 * gradient square, WhatsApp's and Telegram's brand squares) visible in light
 * and dark, the Integrations icon's red dot only for needs_reconnect /
 * EXPIRED (never sync_failed), and no sync-progress polling once the
 * Integrations panel is closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';

import {
  API_BASE,
  chips,
  iconGlow,
  iconTile,
  listOf,
  one,
  progress,
  progressCalls,
  renderDesktop,
  row,
  rowEl,
  serveList,
  type Row,
} from './integrations-accounts.fixtures';
import { MeetingNotesIcon } from '@/features/integrations/components/MeetingNotesProviderCard';
import firefliesLogo from '@/assets/fireflies-logo.svg';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

describe('Rose Desktop integrations: stock app-icon tiles', () => {
  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  /** Every row's icon is the stock tile: light #f5f5f5 frame + the existing app glyph. */
  function expectStockTiles() {
    const keys = [
      'browser-cookies',
      'chrome-passwords',
      'apple-passwords',
      'atlas-passwords',
      'imessage',
      'gmail',
      'whatsapp',
      'telegram',
      'messenger',
      'claude',
      'codex',
      'gemini',
      'plaid',
      'x',
      'linkedin',
      'instagram',
      'file-system',
    ];
    for (const key of keys) {
      const tile = iconTile(key);
      // #f5f5f5 tile (jsdom normalizes colors to rgb).
      expect(tile.getAttribute('style'), key).toContain(
        'linear-gradient(rgb(245, 245, 245), rgb(245, 245, 245))',
      );
      expect(tile.querySelector('svg, img'), key).not.toBeNull();
    }
    // iMessage: green gradient rounded square + white bubble.
    const imessage = iconTile('imessage').querySelector('svg');
    const stops = [...(imessage?.querySelectorAll('stop') ?? [])].map((s) =>
      s.getAttribute('stop-color'),
    );
    expect(stops).toEqual(['#5bf675', '#1fcc3f']);
    const imessageRect = imessage?.querySelector('rect');
    expect(imessageRect?.getAttribute('fill')).toBe('url(#desktopImessageGrad)');
    expect(imessageRect?.getAttribute('rx')).toBe('5');
    expect(imessage?.querySelector('path')?.getAttribute('fill')).toBe('white');
    // WhatsApp / Telegram: their brand-colored rounded squares.
    expect(iconTile('whatsapp').querySelector('rect')?.getAttribute('fill')).toBe('#25D366');
    expect(iconTile('telegram').querySelector('rect')?.getAttribute('fill')).toBe('#229ED9');
    // No glyph inherits the theme's text color: currentColor glyphs are pinned dark.
    for (const svg of rowEl('codex').querySelectorAll('svg')) {
      if (svg.getAttribute('fill') !== 'currentColor') continue;
      expect(svg.closest('.text-\\[\\#111111\\]')).not.toBeNull();
    }
    expect(rowEl('plaid').querySelector('svg.text-\\[\\#111111\\]')).not.toBeNull();
    // Fireflies' transparent mark is centered with padding, not cropped edge-to-edge.
    const fireflies = iconTile('fireflies').getAttribute('style') ?? '';
    expect(fireflies).toContain('--dropdown-icon-fit: contain');
    expect(fireflies).toContain('--dropdown-icon-scale: 0.64');
    expect(iconTile('granola').getAttribute('style')).toContain('--dropdown-icon-fit: cover');
  }

  it('light mode: every icon sits on its stock tile; connected tiles glow rose', async () => {
    serveList(() => listOf(one('imessage', { state: 'synced' })));
    await renderDesktop();
    await waitFor(() => expect(chips('imessage')).toHaveLength(1));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expectStockTiles();
    expect(iconGlow('imessage')).not.toBeNull();
    expect(iconGlow('whatsapp')).toBeNull();
  });

  it('dark mode: the same tiles and glyph colors, so every icon stays visible', async () => {
    localStorage.setItem('rose-theme:theme-user', 'dark');
    serveList(() => listOf(one('whatsapp', { state: 'synced' })));
    await renderDesktop({ roseThemeUserId: 'theme-user' });
    await waitFor(() => expect(chips('whatsapp')).toHaveLength(1));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expectStockTiles();
    expect(iconGlow('whatsapp')).not.toBeNull();
  });
});

describe('Integrations red dot (needs_reconnect / EXPIRED only)', () => {
  beforeEach(() => mockSession());
  afterEach(() => localStorage.clear());

  async function dotFor(rows: Row[]): Promise<boolean> {
    let served = false;
    server.use(
      http.get(`${API_BASE}/integrations`, () => {
        served = true;
        return HttpResponse.json({ integrations: rows });
      }),
    );
    renderWithProviders(<RoseAppIcons />);
    await waitFor(() => expect(served).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    return screen.queryByTestId('rose-app-integrations-alert') !== null;
  }

  it('an account in needs_reconnect raises the dot', async () => {
    expect(await dotFor([one('whatsapp', { state: 'needs_reconnect' })])).toBe(true);
  });

  it('an account in EXPIRED raises the dot', async () => {
    expect(await dotFor([one('linkedin', { state: 'EXPIRED' })])).toBe(true);
  });

  it('sync_failed and syncing accounts never raise it', async () => {
    expect(
      await dotFor([
        one('imessage', { state: 'sync_failed', lastError: 'boom' }),
        one('whatsapp', { state: 'syncing', progress: progress({ done: 1, total: 2 }) }),
        row('chrome', undefined, { status: 'SYNC_FAILED' }),
      ]),
    ).toBe(false);
  });
});

describe('Integrations panel: no polling once closed', () => {
  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('a syncing integration polls while the panel is open and stops when it closes', async () => {
    serveList(
      () =>
        listOf(
          one('imessage', {
            state: 'syncing',
            progress: progress({ done: 1, total: 100, unit: 'messages' }),
          }),
        ),
      () => ({ cursor: 'c', changed: false }),
    );
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    await user.click(screen.getByTestId('rose-app-integrations'));
    const body = screen.getByTestId('rose-app-panel-integrations');
    await waitFor(() => expect(within(body).getAllByTestId('sync-progress')).toHaveLength(1));

    await waitFor(() => expect(progressCalls().length).toBeGreaterThan(0), { timeout: 7_000 });
    await user.click(screen.getByTestId('rose-app-integrations'));
    expect(screen.getByTestId('rose-app-panel')).toHaveAttribute('data-state', 'closed');
    await waitFor(() => expect(screen.queryByTestId('rose-desktop-integrations')).toBeNull());
    const after = progressCalls().length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
    });
    expect(progressCalls()).toHaveLength(after);
  }, 20_000);
});

describe('meeting note taker logos', () => {
  it('Fireflies uses the official fireflies.ai mark asset', () => {
    const { container } = renderWithProviders(<MeetingNotesIcon provider="fireflies" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(firefliesLogo);
  });
});
