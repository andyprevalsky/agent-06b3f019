/**
 * Blackbox tests for the Rose desktop chrome approved in rose-user-ui:
 *  - query-box toolbar on the rose tab behind the box (hover / focus / tap);
 *    geometry, tooltips and items: rose-desktop-flag.blackbox.tsx
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
import { makeItem as makePlaidItem } from './plaid.fixtures';

import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import BrowserStatusBar from '@/features/terminal-component-group/components/BrowserStatusBar';
import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';
import { TOOLBAR_LEAVE_GRACE_MS } from '@/features/terminal-component-group/components/query-input/useToolbarReveal';
import {
  addressParts,
  latestBrowserPageUrl,
} from '@/features/terminal-component-group/components/rose-apps/browserPageUrl';
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

  it('keeps the strip hidden (but mounted) in the closed 4px tab by default', () => {
    const { nub, region } = renderQueryInput();
    expect(nub).toHaveAttribute('data-state', 'closed');
    expect(region).toHaveAttribute('data-state', 'closed');
    expect(region).toHaveStyle({ opacity: '0', pointerEvents: 'none' });
    expect(nub.style.top).toBe('-4px');
    expect(nub.style.background).toContain('linear-gradient');
    expect(region.id).not.toBe('');
    // The strip stays mounted (lock etc.) while the tab is closed.
    expect(within(region).getByTestId('nub-write-lock')).toBeInTheDocument();
  });

  it('opens on hover, survives the leave grace when re-entered, closes after leaving', () => {
    vi.useFakeTimers();
    const { nub, region } = renderQueryInput();
    fireEvent.pointerEnter(nub, { pointerType: 'mouse' });
    expect(region).toHaveAttribute('data-state', 'open');
    expect(region).toHaveStyle({ opacity: '1', pointerEvents: 'auto' });

    // Brushing off the tab and straight back keeps it open past the grace.
    fireEvent.pointerLeave(nub, { pointerType: 'mouse' });
    fireEvent.pointerEnter(nub, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(TOOLBAR_LEAVE_GRACE_MS + 50));
    expect(region).toHaveAttribute('data-state', 'open');

    fireEvent.pointerLeave(nub, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(TOOLBAR_LEAVE_GRACE_MS - 50));
    expect(region).toHaveAttribute('data-state', 'open');
    act(() => vi.advanceTimersByTime(100));
    expect(region).toHaveAttribute('data-state', 'closed');
  });

  it('opens on keyboard focus of an item and closes when focus leaves the tab', () => {
    const { nub, region } = renderQueryInput();
    const lock = within(nub).getByTestId('nub-write-lock');
    act(() => lock.focus());
    expect(region).toHaveAttribute('data-state', 'open');
    expect(lock.tagName).toBe('BUTTON');
    act(() => lock.blur());
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
    expect(browser).toHaveStyle({ color: '#9cddff' });
    const drawer = screen.getByTestId('browser-app-drawer');
    expect(drawer).toHaveAttribute('data-state', 'open');
    // Full height, from the left bar to the window's right edge; no close X.
    expect(drawer).toHaveAttribute('data-variant', 'full');
    expect(drawer.style.left).toBe('64px');
    expect(drawer.style.right).toBe('0px');
    expect(drawer.style.top).toBe('0px');
    expect(within(drawer).queryByRole('button', { name: /close/i })).toBeNull();
    // The icon row floats over the drawer's top-right corner (it stacks above it).
    expect(row.style.right).toBe('16px');
    expect(row.style.left).toBe('');
    expect(row.style.transform).toBe('');
    expect(row.className).toContain('z-[103]');
    expect(drawer.className).toContain('z-[102]');
    expect(screen.getByTestId('root-browser-empty')).toHaveTextContent('Your browser');

    // Clicking the active icon is how the drawer closes.
    await user.click(browser);
    expect(browser).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('browser-app-drawer')).toHaveAttribute('data-state', 'closed');
  });

  it('Phone shows only the floating Coming soon device, 24px off the right edge', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    expect(screen.queryByTestId('rose-phone')).toBeNull();
    await user.click(screen.getByTestId('rose-app-phone'));
    const phone = screen.getByTestId('rose-phone');
    expect(phone.style.right).toBe('24px');
    expect(phone.style.top).toBe('50%');
    expect(phone.style.transform).toBe('translateY(-50%)');
    expect(phone.className).not.toMatch(WRAPPER_CLASS);
    // No background anywhere: only the device over the page.
    expect(phone.className).not.toMatch(/\bbg-|backdrop/);
    expect(phone.style.background).toBe('');
    expect(phone.style.backgroundColor).toBe('');
    const device = within(phone).getByTestId('rose-phone-device');
    expect([...phone.children]).toEqual([device]);
    expect(device.style.boxShadow).toContain('rgba(0,0,0,.35)');
    expect(device).toHaveTextContent('Select an agent to view its phone.');
    expect(within(phone).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('rose-app-panel')).toHaveAttribute('data-state', 'closed');
    // One app at a time: opening Integrations hides the phone.
    await user.click(screen.getByTestId('rose-app-integrations'));
    expect(screen.queryByTestId('rose-phone')).toBeNull();
    expect(screen.getByTestId('rose-app-panel')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('rose-app-panel').className).toContain('z-[102]');
    const icons = screen.getByTestId('rose-app-icons');
    expect(icons.className).toContain('z-[103]');
    expect(icons.style.right).toBe('16px');
    expect(icons.style.top).toBe('11px');
    await user.click(screen.getByTestId('rose-app-browser'));
    expect(icons.className).toContain('z-[103]');
    expect(screen.getByTestId('browser-app-drawer').className).toContain('z-[102]');
  });

  it('Dark mode is a toggle (moon → sun, label swaps) that drives RoseThemeProvider and opens no panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />, { roseThemeUserId: 'theme-user' });
    try {
      await user.click(screen.getByTestId('rose-app-dark-mode'));
      expect(screen.getByTestId('rose-app-dark-mode')).toHaveAttribute('aria-label', 'Light mode');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      // One source of truth: the icon toggles features/rose-theme, which persists per user.
      expect(localStorage.getItem('rose-theme:theme-user')).toBe('dark');
      expect(screen.getByTestId('rose-app-panel')).toHaveAttribute('data-state', 'closed');
      await user.click(screen.getByTestId('rose-app-dark-mode'));
      expect(screen.getByTestId('rose-app-dark-mode')).toHaveAttribute('aria-label', 'Dark mode');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(localStorage.getItem('rose-theme:theme-user')).toBe('light');
    } finally {
      localStorage.removeItem('rose-theme:theme-user');
      document.documentElement.classList.remove('dark');
    }
  });

  it('Dark mode is a no-op outside a signed-in Rose Desktop theme (stock stays light)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    await user.click(screen.getByTestId('rose-app-dark-mode'));
    expect(screen.getByTestId('rose-app-dark-mode')).toHaveAttribute('aria-label', 'Dark mode');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('Integrations shows a red reconnect dot when an integration needs reconnection', async () => {
    server.use(
      http.get(`${API_BASE}/integrations`, () =>
        HttpResponse.json({
          integrations: [
            {
              name: 'gmail',
              status: 'CONNECTED',
              emailCredentials: [{ email: 'a@b.c', state: 'needs_reconnect' }],
            },
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

  it('a Plaid bank that needs sign-in also raises the dot, named in the tooltip', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({
          items: [makePlaidItem({ institutionName: 'Chase', status: 'REQUIRES_REAUTH' })],
        }),
      ),
    );
    mockSession();
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    expect(await screen.findByTestId('rose-app-integrations-alert')).toBeInTheDocument();
    await user.hover(screen.getByTestId('rose-app-integrations'));
    expect(
      (await screen.findAllByText('Integrations · reconnect Plaid (Chase)')).length,
    ).toBeGreaterThan(0);
  });

  it('Integrations drawer mounts the existing Integrations page', async () => {
    mockSession();
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    await user.click(screen.getByTestId('rose-app-integrations'));
    const body = screen.getByTestId('rose-app-panel-integrations');
    // Rose Desktop integrations: section headings (a row may repeat the same name).
    await waitFor(() =>
      expect(within(body).getByRole('heading', { name: 'Browser Cookies' })).toBeInTheDocument(),
    );
    expect(within(body).getByRole('heading', { name: 'Passwords' })).toBeInTheDocument();
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

  it.each([false, true])(
    'moves the same draft and send channel into Browser and restores it on close (native: %s)',
    async (directChannel) => {
      const submit = vi.fn();
      const user = userEvent.setup();
      function Draft() {
        const [value, setValue] = React.useState('Keep this draft');
        return (
          <QueryInput
            liftAboveApps
            directChannel={directChannel}
            value={value}
            onChange={setValue}
            onSubmit={submit}
            selectedModel="rose-labs/rose-1-flash"
            canSubmit
          />
        );
      }
      renderWithProviders(
        withAgent(
          [ACTION],
          'agent-a',
          <>
            <Draft />
            <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />
          </>,
        ),
        { selectedAgentId: 'agent-a' },
      );
      expect(screen.getByTestId('query-input-layer')).toContainElement(screen.getByRole('textbox'));
      await user.click(screen.getByTitle('Preview').parentElement!);
      const composer = await screen.findByTestId('browser-query-input');
      expect(screen.queryByTestId('query-input-layer')).toBeNull();
      expect(screen.getAllByRole('textbox')).toHaveLength(1);
      expect(screen.getByTestId('browser-composer-slot')).toContainElement(composer);
      const input = within(composer).getByRole('textbox');
      expect(input).toHaveValue('Keep this draft');
      await user.type(input, ' safely');
      await user.keyboard('{Enter}');
      expect(submit).toHaveBeenCalledOnce();
      await user.keyboard('{Escape}');
      expect(screen.queryByTestId('browser-query-input')).toBeNull();
      expect(screen.getByTestId('query-input-layer')).toContainElement(screen.getByRole('textbox'));
      expect(screen.getByRole('textbox')).toHaveValue('Keep this draft safely');
    },
  );

  it('has browser chrome: Back / Forward dimmed, Reload remounts the live view, address bar shows the page', async () => {
    const user = userEvent.setup();
    const navigated: Message = {
      ...ACTION,
      message_id: 'm-2',
      metadata: {
        task_id: 'task-1',
        action_type: 'navigate',
        title: 'Opening tickets',
        browser_session_metadata: {
          proxy_source: 'byop',
          proxy_location: { city: 'San Francisco', country: 'US' },
        },
        auxiliary: { current_url: 'https://www.palisadestahoe.com/lift-tickets/2026-27' },
      },
    };
    renderWithProviders(
      withAgent(
        [ACTION, navigated],
        'agent-a',
        <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />,
      ),
    );
    await user.click(screen.getByTitle('Preview').parentElement!);
    const drawer = screen.getByTestId('browser-app-drawer');
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'open'));

    const chrome = within(drawer).getByTestId('browser-chrome');
    const labels = within(chrome)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);
    // Mode, agent tabs and proxy share one row; navigation has no Live/Sites extras.
    expect(labels).toEqual(['Back', 'Forward', 'Reload']);
    const row = within(drawer).getByTestId('browser-tabs-row');
    expect(row).toContainElement(within(drawer).getByRole('group', { name: 'Browser mode' }));
    expect(row).toContainElement(within(drawer).getByRole('tablist', { name: 'Browser tabs' }));
    expect(row).toContainElement(within(drawer).getByLabelText('Browser proxy location'));
    expect(within(drawer).queryByTestId('browser-drawer-live')).toBeNull();
    expect(within(chrome).getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(within(chrome).getByRole('button', { name: 'Forward' })).toBeDisabled();
    const address = within(chrome).getByTestId('browser-address-bar');
    expect(address.className).toContain('rounded-full');
    expect(within(address).getByText('www.palisadestahoe.com').tagName).toBe('B');
    expect(address).toHaveTextContent('www.palisadestahoe.com/lift-tickets/2026-27');

    // Reload remounts the agent's live view (a fresh viewer connection).
    const before = within(drawer).getByTestId('browser-agent-pane');
    const reload = within(chrome).getByRole('button', { name: 'Reload' });
    expect(reload).toBeEnabled();
    await user.click(reload);
    const after = within(drawer).getByTestId('browser-agent-pane');
    expect(after).not.toBe(before);
    expect(before.isConnected).toBe(false);

    // Root: nothing to reload, no page.
    await user.click(within(drawer).getByTestId('browser-tab-root'));
    expect(within(chrome).getByRole('button', { name: 'Reload' })).toBeDisabled();
    expect(within(chrome).getByTestId('browser-address-bar')).toHaveTextContent('Your browser');
  });

  it('reads the page URL from the latest browser step of that task only', () => {
    const msg = (id: string, metadata: Record<string, unknown>): Message => ({
      ...ACTION,
      message_id: id,
      metadata: metadata as Message['metadata'],
    });
    expect(latestBrowserPageUrl([], 'task-1')).toBeNull();
    expect(
      latestBrowserPageUrl(
        [
          msg('a', { task_id: 'task-1', current_url: 'https://first.example/a' }),
          msg('b', { task_id: 'task-1', target_url: 'https://second.example/b?q=1' }),
          msg('c', { task_id: 'task-2', url: 'https://other-task.example' }),
          msg('d', { task_id: 'task-1', title: 'no url', url: 'about:blank' }),
        ],
        'task-1',
      ),
    ).toBe('https://second.example/b?q=1');
    expect(addressParts('https://second.example/b?q=1')).toEqual({
      host: 'second.example',
      rest: '/b?q=1',
    });
    expect(addressParts('https://second.example/')).toEqual({ host: 'second.example', rest: '' });
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
