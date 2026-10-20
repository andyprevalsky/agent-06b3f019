/**
 * Blackbox tests for the Rose desktop chrome approved in rose-user-ui:
 *  - query-box toolbar hidden behind the rose nub (hover / focus / tap)
 *  - right app bar with bare icons (no tiles/chips/rings around them)
 *  - Browser drawer replaces the fullscreen browser (opens on the agent tab,
 *    resizable with a clamped width)
 *  - Voice app selection + persona bound to the custom system prompt
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
import { RoseAppBar } from '@/features/terminal-component-group/components/rose-apps/RoseAppBar';
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

// ─── Right app bar ──────────────────────────────────────────────────────────

const WRAPPER_CLASS = /\b(border|bg-|rounded|ring|shadow)/;

describe('right app bar', () => {
  it('renders Browser and Voice as bare icons and colors the open app', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoseAppBar />);
    const bar = screen.getByTestId('rose-app-bar');
    expect(bar.className).toContain('right-0');
    expect(bar.className).toContain('bg-white');
    expect(bar.className).toContain('border-l');
    const browser = screen.getByTestId('rose-app-browser');
    const voice = screen.getByTestId('rose-app-voice');
    for (const button of [browser, voice]) {
      expect(button.className).not.toMatch(WRAPPER_CLASS);
      expect(button.style.background).toBe('');
      expect(button.style.border).toBe('');
    }
    expect(within(voice).getByTestId('rose-voice-orb')).toBeInTheDocument();
    expect(within(voice).getByTestId('rose-voice-orb-mic')).toBeInTheDocument();

    expect(browser).toHaveAttribute('aria-pressed', 'false');
    await user.click(browser);
    expect(browser).toHaveAttribute('aria-pressed', 'true');
    expect(browser).toHaveStyle({ color: '#e8507f' });
    expect(screen.getByTestId('browser-app-drawer')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('root-browser-empty')).toHaveTextContent('Your browser');

    await user.click(voice);
    expect(screen.getByTestId('browser-app-drawer')).toHaveAttribute('data-state', 'closed');
    expect(screen.getByTestId('voice-app-drawer')).toHaveAttribute('data-state', 'open');
    expect(within(voice).getByTestId('rose-voice-orb-mic')).toHaveStyle({ color: '#e8507f' });
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

  it('clamps the drawer width when resized', async () => {
    expect(clampDrawerWidth(100, 1440)).toBe(DRAWER_MIN_WIDTH);
    expect(clampDrawerWidth(5000, 1440)).toBe(1440 - 64 - 24 - 320);
    expect(clampDrawerWidth(700, 1440)).toBe(700);
    // On a narrow viewport the minimum still wins.
    expect(clampDrawerWidth(5000, 600)).toBe(DRAWER_MIN_WIDTH);
    expect(drawerWidthFromPointer(1440 - 64 - 12 - 600, 1440)).toBe(600);

    const user = userEvent.setup();
    renderWithProviders(<RoseAppBar />);
    await user.click(screen.getByTestId('rose-app-browser'));
    const drawer = screen.getByTestId('browser-app-drawer');
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

// ─── Voice app ──────────────────────────────────────────────────────────────

describe('Voice app', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
  });

  it('selects a voice (bold dark label) and saves the persona to the custom system prompt', async () => {
    const patches: unknown[] = [];
    server.use(
      http.get(`${API_BASE}/user-settings`, () =>
        HttpResponse.json({ customSystemPrompt: 'Warm and direct.' }),
      ),
      http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<RoseAppBar />);
    await user.click(screen.getByTestId('rose-app-voice'));
    const drawer = screen.getByTestId('voice-app-drawer');

    const rose = within(drawer).getByTestId('voice-option-rose');
    const seraph = within(drawer).getByTestId('voice-option-seraph');
    expect(rose).toHaveAttribute('aria-checked', 'true');
    expect(rose).toHaveStyle({ fontWeight: '600' });
    expect(within(drawer).getAllByTestId('rose-voice-orb-mic')).toHaveLength(3);

    await user.click(seraph);
    expect(seraph).toHaveAttribute('aria-checked', 'true');
    expect(seraph).toHaveStyle({ fontWeight: '600' });
    expect(rose).toHaveAttribute('aria-checked', 'false');
    expect(rose).toHaveStyle({ fontWeight: '400' });
    expect(localStorage.getItem('rose-voice')).toBe('seraph');
    // The app-bar orb follows the selection (Seraph hue-rotate 190).
    const barOrb = within(screen.getByTestId('rose-app-voice')).getByTestId('rose-voice-orb');
    expect(barOrb.innerHTML).toContain('hue-rotate(190deg)');

    const persona = within(drawer).getByTestId('voice-persona');
    await waitFor(() => expect(persona).toHaveValue('Warm and direct.'));
    await user.clear(persona);
    await user.type(persona, 'Short and funny.');
    fireEvent.blur(persona);
    await waitFor(() => expect(patches).toEqual([{ customSystemPrompt: 'Short and funny.' }]));
  });
});
