/**
 * Blackbox tests for the Rose desktop chrome approved in rose-user-ui:
 *  - query-box toolbar hidden behind the rose nub (hover / focus / tap)
 *  - top-right app icons (no right bar): bare icons, no tiles/chips/rings
 *  - Browser drawer replaces the fullscreen browser (opens on the agent tab,
 *    full height from the left bar to the right edge)
 *  - flush, full-height right panels, resizable with a clamped width
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import BrowserStatusBar from '@/features/terminal-component-group/components/BrowserStatusBar';
import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';
import { TOOLBAR_LEAVE_GRACE_MS } from '@/features/terminal-component-group/components/query-input/useToolbarReveal';
import {
  DRAWER_MIN_WIDTH,
  clampDrawerWidth,
  drawerWidthFromPointer,
} from '@/features/terminal-component-group/components/rose-apps/roseAppsLayout';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import type { Message } from '@/lib/api';

const API_BASE = 'http://localhost:3001/api';

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

function agentContext(messages: Message[], agentId: string): AgentContextValue {
  return {
    agent: null,
    applyAgentDetail: vi.fn(() => true),
    selectedAgentId: agentId,
    setSelectedAgentId: vi.fn(),
    messages,
    streamingBubbles: new Map(),
    streamingPlan: null,
    streamingAttention: null,
    streamingTools: new Map(),
    streamedTextsRef: { current: new Set<string>() },
    registerMessageHandler: vi.fn(() => () => {}),
    sendMessage: vi.fn(async () => {}),
    isLoadingAgent: false,
    forceResubscribe: vi.fn(),
    isChatMode: false,
    inspectionContext: null,
    stagePendingAgentCreation: vi.fn(),
    reconcilePendingAgentCreation: vi.fn(async () => {}),
    rollbackPendingAgentCreation: vi.fn(() => false),
  };
}

function withAgent(messages: Message[], agentId: string, children: React.ReactNode) {
  return (
    <AgentContext.Provider value={agentContext(messages, agentId)}>
      {children}
    </AgentContext.Provider>
  );
}

const ACTION: Message = {
  message_id: 'm-1',
  timestamp: '2026-01-01T00:00:00Z',
  text: '',
  role: 'TOOL',
  metadata: { task_id: 'task-1', action_type: 'click', title: 'Clicking around' },
};

// ─── Query-box toolbar nub ──────────────────────────────────────────────────

describe('query toolbar nub', () => {
  beforeEach(() => mockSession());
  afterEach(() => vi.useRealTimers());

  function renderQueryInput() {
    renderWithProviders(
      <QueryInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        selectedModel="rose-labs/rose-1-flash"
      />,
    );
    return {
      nub: screen.getByTestId('query-toolbar-nub'),
      region: screen.getByTestId('query-toolbar-region'),
    };
  }

  it('hides the toolbar behind the rose nub by default', () => {
    const { nub, region } = renderQueryInput();
    expect(region).toHaveAttribute('data-state', 'closed');
    expect(region.style.maxHeight).toMatch(/^0(px)?$/);
    expect(region.style.opacity).toBe('0');
    expect(nub).toHaveAttribute('aria-expanded', 'false');
    expect(nub).toHaveAttribute('aria-controls', region.id);
    expect(nub.style.background).toContain('linear-gradient');
    expect(nub.className).toContain('w-[30px]');
    expect(nub.className).toContain('h-[9px]');
    expect(nub.className).toContain('top-[7px]');
    expect(nub.className).toContain('left-[7px]');
    // The toolbar stays mounted (Safe Writes etc.) while collapsed.
    expect(within(region).getByText(/Safe Writes|Write/i)).toBeInTheDocument();
  });

  it('expands on nub hover, stays open over the toolbar, collapses after leaving', () => {
    vi.useFakeTimers();
    const { nub, region } = renderQueryInput();
    fireEvent.pointerEnter(nub, { pointerType: 'mouse' });
    expect(region).toHaveAttribute('data-state', 'open');
    expect(region).toHaveStyle({ maxHeight: '60px', opacity: '1' });
    expect(nub).toHaveAttribute('aria-expanded', 'true');

    // Moving from the nub onto the toolbar keeps it open.
    fireEvent.pointerLeave(nub, { pointerType: 'mouse' });
    fireEvent.pointerEnter(region, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(TOOLBAR_LEAVE_GRACE_MS + 50));
    expect(region).toHaveAttribute('data-state', 'open');

    fireEvent.pointerLeave(region, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(TOOLBAR_LEAVE_GRACE_MS + 50));
    expect(region).toHaveAttribute('data-state', 'closed');
  });

  it('opens on keyboard focus and closes when focus leaves', () => {
    const { nub, region } = renderQueryInput();
    act(() => nub.focus());
    expect(region).toHaveAttribute('data-state', 'open');
    expect(nub.tagName).toBe('BUTTON');
    act(() => nub.blur());
    expect(region).toHaveAttribute('data-state', 'closed');
  });

  it('toggles with a touch tap', () => {
    const { nub, region } = renderQueryInput();
    fireEvent.pointerDown(nub, { pointerType: 'touch' });
    fireEvent.click(nub);
    expect(region).toHaveAttribute('data-state', 'open');
    fireEvent.pointerDown(nub, { pointerType: 'touch' });
    fireEvent.click(nub);
    expect(region).toHaveAttribute('data-state', 'closed');
  });
});

// ─── Top-right app icons (no right bar) ─────────────────────────────────────

const WRAPPER_CLASS = /\b(border|bg-|rounded|ring|shadow)/;

describe('top-right app icons', () => {
  it('renders Browser, Phone, Integrations and Dark mode bare; no right bar or removed apps', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    const row = screen.getByTestId('rose-app-icons');
    expect(row.className).toContain('fixed');
    expect(row.className).not.toMatch(WRAPPER_CLASS);
    expect(row.style.right).toBe('16px');
    expect(screen.queryByTestId('rose-app-bar')).toBeNull();
    const labels = within(row)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Browser', 'Phone', 'Integrations', 'Dark mode']);
    for (const removed of ['voice', 'files', 'terminal', 'network', 'payments', 'benchmarks']) {
      expect(screen.queryByTestId(`rose-app-${removed}`)).toBeNull();
    }
    const browser = screen.getByTestId('rose-app-browser');
    expect(browser.className).not.toMatch(WRAPPER_CLASS);
    expect(browser.style.width).toBe('34px');

    expect(browser).toHaveAttribute('aria-pressed', 'false');
    await user.click(browser);
    expect(browser).toHaveAttribute('aria-pressed', 'true');
    expect(browser).toHaveStyle({ color: '#e8507f' });
    const drawer = screen.getByTestId('browser-app-drawer');
    expect(drawer).toHaveAttribute('data-state', 'open');
    // Full height, from the left bar to the window's right edge; no close X.
    expect(drawer).toHaveAttribute('data-variant', 'full');
    expect(drawer.style.left).toBe('64px');
    expect(drawer.style.right).toBe('0px');
    expect(drawer.style.top).toBe('0px');
    expect(within(drawer).queryByRole('button', { name: /close/i })).toBeNull();
    expect(screen.getByTestId('root-browser-empty')).toHaveTextContent('Your browser');

    // Clicking the active icon is how the drawer closes.
    await user.click(browser);
    expect(browser).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('browser-app-drawer')).toHaveAttribute('data-state', 'closed');
  });

  it('Phone shows only the floating device + Take control, 24px off the right edge', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    expect(screen.queryByTestId('rose-phone')).toBeNull();
    await user.click(screen.getByTestId('rose-app-phone'));
    const phone = screen.getByTestId('rose-phone');
    expect(phone.style.right).toBe('24px');
    expect(phone.style.top).toBe('50%');
    expect(phone.style.transform).toBe('translateY(-50%)');
    expect(phone.className).not.toMatch(WRAPPER_CLASS);
    expect(within(phone).getByTestId('rose-phone-device').style.boxShadow).toContain('rgba(0,0,0,.35)');
    expect(within(phone).getByRole('button', { name: 'Take control' })).toBeInTheDocument();
    expect(screen.getByTestId('rose-app-panel')).toHaveAttribute('data-state', 'closed');
    // One app at a time: opening Integrations hides the phone.
    await user.click(screen.getByTestId('rose-app-integrations'));
    expect(screen.queryByTestId('rose-phone')).toBeNull();
    expect(screen.getByTestId('rose-app-panel')).toHaveAttribute('data-state', 'open');
  });

  it('Dark mode is a toggle (moon → sun, label swaps) and opens no panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    try {
      await user.click(screen.getByTestId('rose-app-dark-mode'));
      expect(screen.getByTestId('rose-app-dark-mode')).toHaveAttribute('aria-label', 'Light mode');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(screen.getByTestId('rose-app-panel')).toHaveAttribute('data-state', 'closed');
      await user.click(screen.getByTestId('rose-app-dark-mode'));
      expect(screen.getByTestId('rose-app-dark-mode')).toHaveAttribute('aria-label', 'Dark mode');
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('Integrations shows a red reconnect dot when an integration needs reconnection', async () => {
    server.use(
      http.get(`${API_BASE}/integrations`, () =>
        HttpResponse.json({
          integrations: [
            { name: 'gmail', status: 'CONNECTED', emailCredentials: [{ email: 'a@b.c', state: 'needs_reconnect' }] },
            { name: 'whatsapp', status: 'CONNECTED' },
          ],
        }),
      ),
    );
    mockSession();
    renderWithProviders(<RoseAppIcons />);
    const dot = await screen.findByTestId('rose-app-integrations-alert');
    expect(dot.className).toContain('bg-[#ef4444]');
    expect(dot.className).toContain('h-[7px]');
    expect(screen.queryByTestId('rose-app-browser-alert')).toBeNull();
  });

  it('a healthy account shows no reconnect dot', async () => {
    mockSession();
    renderWithProviders(<RoseAppIcons />);
    await waitFor(() => expect(screen.getByTestId('rose-app-integrations')).toBeInTheDocument());
    expect(screen.queryByTestId('rose-app-integrations-alert')).toBeNull();
  });
});

// ─── Browser drawer replaces fullscreen ─────────────────────────────────────

describe('Browser drawer', () => {
  beforeEach(() => mockSession());

  it('opens on the agent tab from the chip thumbnail; no fullscreen overlay mounts', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      withAgent([ACTION], 'agent-a', <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );
    const drawer = screen.getByTestId('browser-app-drawer');
    expect(drawer).toHaveAttribute('data-state', 'closed');
    expect(drawer).toHaveAttribute('aria-hidden', 'true');

    await user.click(screen.getByTitle('Preview').parentElement!);

    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'open'));
    expect(within(drawer).getByTestId('browser-tab-agent-a')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(drawer).getByTestId('browser-tab-root')).toHaveAttribute(
      'aria-selected',
      'false',
    );
    const pane = within(drawer).getByTestId('browser-agent-pane');
    expect(within(pane).getByTitle('Browser')).toBeInTheDocument();
    expect(within(pane).getByText('Task progress')).toBeInTheDocument();
    // The removed fullscreen view rendered a body-level `fixed inset-0` portal.
    expect(document.body.querySelector(':scope > .fixed.inset-0')).toBeNull();
    // Only the drawer streams the session: the inline chip drops its thumbnail.
    expect(screen.queryByTitle('Preview')).not.toBeInTheDocument();

    // Root tab swaps the body to the placeholder.
    await user.click(within(drawer).getByTestId('browser-tab-root'));
    expect(within(drawer).getByTestId('root-browser-empty')).toBeInTheDocument();
    expect(within(drawer).queryByTestId('browser-agent-pane')).not.toBeInTheDocument();
  });

  it('hands control back from the drawer', async () => {
    let controlled = false;
    const modes: string[] = [];
    server.use(
      http.post(`${API_BASE}/browser-session/task/task-1/control`, async ({ request }) => {
        const body = (await request.json()) as { mode?: string };
        modes.push(body.mode ?? '');
        controlled = body.mode === 'user';
        return HttpResponse.json({ state: controlled ? 'user' : 'agent', agentPaused: false });
      }),
      http.get(`${API_BASE}/browser-session/task/task-1/control`, () =>
        HttpResponse.json({ state: controlled ? 'user' : 'agent', agentPaused: false }),
      ),
    );
    window.history.replaceState({}, '', '/?browser-id=task-1');
    const user = userEvent.setup();
    try {
      renderWithProviders(
        withAgent(
          [ACTION],
          'agent-a',
          <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />,
        ),
      );
      const drawer = screen.getByTestId('browser-app-drawer');
      await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'open'));
      await user.click(await within(drawer).findByRole('button', { name: 'Take control' }));
      await user.click(await within(drawer).findByRole('button', { name: 'Hand back control' }));
      expect(
        await within(drawer).findByRole('button', { name: 'Take control' }),
      ).toBeInTheDocument();
      expect(modes).toEqual(['user', 'agent']);
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('clamps the panel width when resized', async () => {
    expect(clampDrawerWidth(100, 1440)).toBe(DRAWER_MIN_WIDTH);
    expect(clampDrawerWidth(5000, 1440)).toBe(1440 - 64 - 320);
    expect(clampDrawerWidth(700, 1440)).toBe(700);
    // On a narrow viewport the minimum still wins.
    expect(clampDrawerWidth(5000, 600)).toBe(DRAWER_MIN_WIDTH);
    expect(drawerWidthFromPointer(1440 - 600, 1440)).toBe(600);

    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    await user.click(screen.getByTestId('rose-app-integrations'));
    const drawer = screen.getByTestId('rose-app-panel');
    // Flush against the right edge, full height, no floating card or close X.
    expect(drawer.style.right).toBe('0px');
    expect(drawer.style.top).toBe('0px');
    expect(drawer.style.bottom).toBe('0px');
    expect(drawer.className).not.toMatch(/rounded-\[14px\]/);
    expect(within(drawer).queryByRole('button', { name: /close/i })).toBeNull();
    const handle = within(drawer).getByTestId('app-drawer-resize-handle');
    // Drag far right: clamps to the minimum width.
    fireEvent.pointerDown(handle, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: window.innerWidth });
    fireEvent.pointerUp(window);
    expect(drawer.style.width).toBe(`${DRAWER_MIN_WIDTH}px`);
    expect(handle).toHaveAttribute('aria-valuenow', String(DRAWER_MIN_WIDTH));
    // Keyboard shrink is clamped too.
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(drawer.style.width).toBe(`${DRAWER_MIN_WIDTH}px`);
  });
});
