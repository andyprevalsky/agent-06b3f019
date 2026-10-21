import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { fakeChannel, mockSession } from './realtime-subscription.fixtures';
import { makeTerminalHookAgent } from './terminal-hooks.fixtures';

vi.mock('@/lib/realtime', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/realtime')>();
  return { ...original, subscribeToAgent: vi.fn(), unsubscribe: vi.fn() };
});

import * as realtime from '@/lib/realtime';
import Terminal from '@/pages/Terminal';

const API_BASE = 'http://localhost:3001/api';
const AGENT_ID = 'ae17b024-5287-4199-84d0-6cce3bd1765d';
const TASK_ID = 'inspection-loading-browser';
const BROWSER_URL = 'https://connect.steel.dev/v1/sessions/inspection-loading/player';
type AgentHandlers = Parameters<typeof realtime.subscribeToAgent>[1];
let handlers: AgentHandlers;
let viewportWidth: number;
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

beforeEach(() => {
  viewportWidth = window.innerWidth;
  window.innerWidth = 390;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  mockSession();
  handlers = {};
  vi.mocked(realtime.subscribeToAgent).mockReset();
  vi.mocked(realtime.subscribeToAgent).mockImplementation(async (_, incoming) => {
    handlers = incoming;
    return fakeChannel();
  });
});

afterEach(() => {
  window.innerWidth = viewportWidth;
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  if (scrollIntoView)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView);
  else delete HTMLElement.prototype.scrollIntoView;
});

function delayedForeignDetail(fail = false) {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = { count: 0 };
  server.use(
    http.get(`${API_BASE}/agents/:agentId`, async ({ params }) => {
      const isForeign = params.agentId === AGENT_ID;
      if (isForeign) {
        reads.count += 1;
        await pending;
      }
      if (isForeign && fail)
        return HttpResponse.json({ error: 'Detail unavailable' }, { status: 500 });
      return HttpResponse.json({
        agent: makeTerminalHookAgent({ agent_id: String(params.agentId) }),
        messages: [],
        pagination: { has_more: false, oldest_timestamp: null },
        inspection_context: isForeign
          ? { user_id: 'c49b4ce3-3489-499d-bfbd-846d04ba6275', name: 'Tamara' }
          : null,
      });
    }),
  );
  return { reads, release };
}

function insertBrowser(agentId: string, id: string) {
  act(() =>
    handlers.onInsert?.({
      agentId,
      id,
      timestamp: '2026-10-14T17:33:50Z',
      role: 'TOOL',
      text: 'Browser session connected',
      metadata: {
        toolName: 'spawn_browser_agent',
        toolCallId: TASK_ID,
        toolStatus: 'IN_PROGRESS',
        action_type: 'session_init',
        task_id: TASK_ID,
        subAgentId: TASK_ID,
        browser_url: BROWSER_URL,
      },
    }),
  );
}

async function selectOwnedRun() {
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole('button', { name: 'Open menu' }));
  await user.click(await screen.findByText('Test agent'));
}

it('keeps the composer read-only until selected detail establishes ownership, then restores owned controls', async () => {
  window.history.replaceState({}, '', `/?agent-id=${AGENT_ID}`);
  const detail = delayedForeignDetail();
  const user = userEvent.setup({ delay: null });
  const view = renderWithProviders(<Terminal />);
  try {
    await waitFor(() => expect(detail.reads.count).toBeGreaterThan(0));
    expect(screen.queryByTestId('terminal-input-area')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Type your message...')).not.toBeInTheDocument();
    await act(async () => detail.release());
    await screen.findByText(/Read-only account inspection/);
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await user.click(await screen.findByText('Test agent'));
    expect(await screen.findByPlaceholderText('Type your message...')).toBeInTheDocument();
    expect(
      screen.getByTestId('query-input-layer').querySelector('svg.lucide-square'),
    ).toBeInTheDocument();
  } finally {
    detail.release();
    view.unmount();
  }
});

it('keeps realtime browser inserts passive while selected detail is unresolved', async () => {
  window.history.replaceState({}, '', `/?agent-id=${AGENT_ID}&browser-id=${TASK_ID}`);
  const detail = delayedForeignDetail();
  const mutations: string[] = [];
  const liveReads = { count: 0 };
  server.use(
    http.get(`${API_BASE}/browser-session/task/:taskId/live-view`, () => {
      liveReads.count += 1;
      return HttpResponse.json({
        taskId: TASK_ID,
        sessionId: 'inspection-loading',
        debugUrl: BROWSER_URL,
        status: 'ACTIVE',
        live: true,
        asOf: 1,
      });
    }),
    http.get(`${API_BASE}/browser-session/task/:taskId/control`, () =>
      HttpResponse.json({ state: 'requested', agentPaused: false, debugUrl: BROWSER_URL }),
    ),
    http.post(`${API_BASE}/browser-session/task/:taskId/control`, ({ request }) => {
      mutations.push(request.url);
      return HttpResponse.json({ state: 'user', agentPaused: false, debugUrl: BROWSER_URL });
    }),
  );
  const view = renderWithProviders(<Terminal />);
  try {
    await waitFor(() => expect(detail.reads.count).toBeGreaterThan(0));
    await waitFor(() => expect(handlers.onInsert).toBeDefined());
    insertBrowser(AGENT_ID, 'inspection-loading-init');
    await waitFor(() => expect(liveReads.count).toBeGreaterThan(0));
    const iframe = await screen.findByTitle('Browser');
    // Let the control read and its dependent automatic lease settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(mutations).toEqual([]);
    expect(new URL(iframe.getAttribute('src')!).searchParams.get('interactive')).toBe('false');
    expect(
      screen.queryByRole('button', { name: /Take control|Hand back|Start Agent/ }),
    ).not.toBeInTheDocument();
    await act(async () => detail.release());
    await screen.findByText(/Read-only account inspection/);
    expect(mutations).toEqual([]);
    await selectOwnedRun();
    await screen.findByTestId('terminal-input-area');
    await waitFor(() =>
      expect(realtime.subscribeToAgent).toHaveBeenLastCalledWith('agent-001', expect.anything()),
    );
    window.history.replaceState({}, '', `/?agent-id=agent-001&browser-id=${TASK_ID}`);
    insertBrowser('agent-001', 'owned-browser-init');
    await screen.findByPlaceholderText('Type your message...');
    await waitFor(() =>
      expect(mutations).toEqual([`${API_BASE}/browser-session/task/${TASK_ID}/control`]),
    );
    expect(await screen.findByRole('button', { name: /Hand back control/ })).toBeInTheDocument();
  } finally {
    detail.release();
    view.unmount();
  }
});

it('preserves the landing composer when no agent is selected', async () => {
  window.history.replaceState({}, '', '/');
  renderWithProviders(<Terminal />);
  expect(await screen.findByTestId('terminal-input-area')).toBeInTheDocument();
});

it('does not acquire a retained browser after selected detail fails', async () => {
  window.history.replaceState({}, '', `/?agent-id=${AGENT_ID}&browser-id=${TASK_ID}`);
  const detail = delayedForeignDetail(true);
  const mutations: string[] = [];
  server.use(
    http.get(`${API_BASE}/browser-session/task/:taskId/live-view`, () =>
      HttpResponse.json({
        taskId: TASK_ID,
        sessionId: 'inspection-loading',
        debugUrl: BROWSER_URL,
        status: 'ACTIVE',
        live: true,
        asOf: 1,
      }),
    ),
    http.get(`${API_BASE}/browser-session/task/:taskId/control`, () =>
      HttpResponse.json({ state: 'requested', agentPaused: false, debugUrl: BROWSER_URL }),
    ),
    http.post(`${API_BASE}/browser-session/task/:taskId/control`, ({ request }) => {
      mutations.push(request.url);
      return HttpResponse.json({ state: 'user', agentPaused: false, debugUrl: BROWSER_URL });
    }),
  );
  const view = renderWithProviders(<Terminal />);
  try {
    await waitFor(() => expect(detail.reads.count).toBeGreaterThan(0));
    await waitFor(() => expect(handlers.onInsert).toBeDefined());
    insertBrowser(AGENT_ID, 'failing-detail-init');
    await screen.findByTitle('Browser');
    expect(mutations).toEqual([]);
    await act(async () => detail.release());
    await waitFor(() =>
      expect(new URL(window.location.href).searchParams.get('agent-id')).toBeNull(),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(mutations).toEqual([]);
    expect(screen.queryByTestId('browser-status-chip')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-input-area')).toBeInTheDocument();
  } finally {
    detail.release();
    view.unmount();
  }
});
