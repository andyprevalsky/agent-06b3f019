/**
 * Blackbox: the "Task Completed" bar above the query box, through the real
 * Terminal (Rose UI by default, the stock UI as a control) with realtime
 * replaced by the exact callbacks the backend emits.
 *
 * STATE MACHINE under test (TaskCompletedBar):
 *   [HIDDEN] --viewed top-level agent's status is COMPLETED--> [SHOWN]
 *            "Task Completed" (left) · "Archive Agent" (right), directly above
 *            the query box, desktop and mobile
 *   [SHOWN]  --status UPDATE leaves COMPLETED (follow-up resumes it)--> [HIDDEN]
 *   [SHOWN]  --Archive Agent--> the sidebar's archive action: DELETE (soft
 *            delete), selection clears, "Archived …" toast, agent list and
 *            attention requests refetch — identical to the Rose sidebar menu
 *   [SHOWN]  --DELETE fails--> "Failed to archive agent" toast, stays [SHOWN]
 *   Hidden for every non-COMPLETED status, for sub-agents (the archived list
 *   restores top-level agents only) and with no agent selected.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/ui/toaster';
import * as roseDesktopFlag from '@/lib/roseDesktop';
import type { AgentDetail, Message } from '@/lib/api';

import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';
import { fakeChannel } from './realtime-subscription.fixtures';
import { makeTerminalHookAgent } from './terminal-hooks.fixtures';
import { renderWithProviders } from './test-wrapper';

vi.mock('@/lib/realtime', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/realtime')>();
  return { ...original, subscribeToAgent: vi.fn(), unsubscribe: vi.fn() };
});

import * as realtime from '@/lib/realtime';
import Terminal from '@/pages/Terminal';

const API_BASE = 'http://localhost:3001/api';
const AGENT_ID = 'done-agent';
const TITLE = 'Lisbon trip plan';
const GOAL_TEXT = 'Plan a 3-day Lisbon trip';
type AgentHandlers = Parameters<typeof realtime.subscribeToAgent>[1];
let handlers: AgentHandlers = {};
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

const MESSAGES: Message[] = [
  { message_id: 'goal', timestamp: '2026-11-12T00:00:00Z', role: 'USER', text: GOAL_TEXT },
];

function setViewport(width: number, height = 844) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function signIn() {
  const user = { id: 'test-user', is_anonymous: false };
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user,
    }),
  );
  localStorage.setItem('app-user', JSON.stringify(user));
}

function agent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return makeTerminalHookAgent({
    agent_id: AGENT_ID,
    goal: GOAL_TEXT,
    title: TITLE,
    status: 'COMPLETED',
    ...overrides,
  });
}

/** The viewed agent's detail + the sidebar list both serve `detail`. */
function serveAgent(detail: AgentDetail) {
  window.history.replaceState({}, '', `/?agent-id=${detail.agent_id}`);
  server.use(
    http.get(`${API_BASE}/agents`, () => HttpResponse.json({ agents: [detail] })),
    http.get(`${API_BASE}/agents/:agentId`, ({ params }) =>
      params.agentId === detail.agent_id
        ? HttpResponse.json({
            agent: detail,
            messages: MESSAGES,
            pagination: { has_more: false, oldest_timestamp: null },
          })
        : HttpResponse.json({ error: 'Not found' }, { status: 404 }),
    ),
  );
}

/** Opens the Terminal on the served agent and waits for its transcript. */
async function renderAgent() {
  const user = userEvent.setup();
  renderWithProviders(
    <>
      <Terminal />
      <Toaster />
    </>,
  );
  await screen.findByPlaceholderText('Type your message...');
  await screen.findAllByText(GOAL_TEXT);
  await waitFor(() => expect(realtime.subscribeToAgent).toHaveBeenCalled());
  return user;
}

const bar = () => screen.queryByTestId('task-completed-bar');

function requestsAfter(index: number, method: string, path: string) {
  return capturedRequests
    .slice(index)
    .filter((r) => r.method === method && new URL(r.url).pathname === `/api${path}`);
}

beforeEach(() => {
  localStorage.clear();
  signIn();
  setViewport(1280, 900);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  handlers = {};
  vi.mocked(realtime.subscribeToAgent).mockReset();
  vi.mocked(realtime.subscribeToAgent).mockImplementation(async (_, incoming) => {
    handlers = incoming;
    return fakeChannel();
  });
  server.use(
    http.get(`${API_BASE}/user/profile`, () => HttpResponse.json({ name: 'Test User' })),
    http.get(`${API_BASE}/user/subscription`, () => HttpResponse.json({ tier: 10 })),
    http.get(`${API_BASE}/user/customization`, () =>
      HttpResponse.json({ systemPrompt: '', contextGates: {} }),
    ),
    http.get(`${API_BASE}/credits/stats`, () =>
      HttpResponse.json({ totalTokens: 0, topModels: [] }),
    ),
  );
  clearCaptures();
});

afterEach(() => {
  vi.restoreAllMocks();
  setViewport(1024, 768);
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  if (scrollIntoView)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView);
  else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

/** Shown contract: label left, button right, flush above the query box, no extra wrappers. */
function expectBarAboveQueryBox(element: HTMLElement) {
  const children = [...element.children];
  // Exactly label · button: no icon, wrapper or chip around either side.
  expect(children.map((child) => child.tagName.toLowerCase())).toEqual(['span', 'button']);
  const [label, button] = children as HTMLElement[];
  expect(label).toHaveTextContent(/^Task Completed$/);
  expect(label.className).toContain('flex-1');
  expect(button).toHaveTextContent(/^Archive Agent$/);
  expect(within(element).getByRole('button', { name: 'Archive Agent' })).toBe(button);
  // The shared ghost Button: no border or pill at rest.
  expect(button.className).toContain('hover:bg-accent');
  expect(button.className).not.toMatch(/\bborder\b|rounded-full/);
  // Same attached surface as the background-agents banner.
  for (const token of ['rounded-t-xl', 'border', 'border-b-0', 'border-border', 'bg-card']) {
    expect(element.className.split(/\s+/)).toContain(token);
  }
  expect(element).toHaveAttribute('data-query-input-attachment');
  // Below a visible background-agents banner it joins flush (square top corners).
  expect(element.className).toContain('[[data-query-input-attachment]+&]:rounded-t-none');
  // Directly above the query box, in its own column (so it moves with the box,
  // including Rose's lifted composer layer); the box squares its top corners.
  const surface = screen.getByTestId('query-input-surface');
  expect(element.nextElementSibling).toBe(surface);
  expect(element.parentElement).toBe(screen.getByTestId('query-input-host'));
  expect(surface.className).toContain(
    'group-has-[[data-query-input-attachment]]/query-input:rounded-t-none',
  );
}

describe('Task Completed bar: show', () => {
  it.each([
    ['desktop', 1280],
    ['mobile', 390],
  ])('%s: a completed agent shows the bar directly above the query box', async (_, width) => {
    setViewport(width);
    serveAgent(agent());
    await renderAgent();
    const shown = await screen.findByTestId('task-completed-bar');
    expectBarAboveQueryBox(shown);
    const area = screen.getByTestId('terminal-input-area');
    // Rose UI on phones: the query area keeps its mobile layout with the bar inside it.
    expect(area.className).toContain('rose-mobile-query-area');
  });

  it('stock UI control: the same bar sits above the stock query box', async () => {
    vi.spyOn(roseDesktopFlag, 'isRoseDesktopUser').mockReturnValue(false);
    serveAgent(agent());
    await renderAgent();
    expectBarAboveQueryBox(await screen.findByTestId('task-completed-bar'));
    expect(screen.getByTestId('terminal-input-area').className).not.toContain(
      'rose-mobile-query-area',
    );
  });

  it('appears when the running agent completes and hides when a follow-up resumes it', async () => {
    serveAgent(agent({ status: 'ACTIVE' }));
    await renderAgent();
    expect(bar()).toBeNull();

    act(() => handlers.onUpdate?.({ agentId: AGENT_ID, status: 'COMPLETED' }));
    expectBarAboveQueryBox(await screen.findByTestId('task-completed-bar'));

    act(() => handlers.onUpdate?.({ agentId: AGENT_ID, status: 'ACTIVE' }));
    await waitFor(() => expect(bar()).toBeNull());
  });
});

describe('Task Completed bar: hide', () => {
  it.each([
    'STARTING_UP',
    'ACTIVE',
    'PAUSED',
    'OUT_OF_CREDITS',
    'FAILED',
    'COST_LIMIT_REACHED',
  ] as const)('hidden while the agent is %s', async (status) => {
    serveAgent(agent({ status }));
    await renderAgent();
    expect(screen.getByTestId('query-input-surface')).toBeInTheDocument();
    expect(bar()).toBeNull();
  });

  it('hidden for a completed sub-agent (archive restores top-level agents only)', async () => {
    serveAgent(agent({ parent_agent_id: 'root-agent', parent_goal: 'Root goal' }));
    await renderAgent();
    expect(bar()).toBeNull();
  });

  it('hidden with no agent selected', async () => {
    renderWithProviders(<Terminal />);
    await screen.findByPlaceholderText('Enter any goal');
    expect(bar()).toBeNull();
  });
});

/** The observable effects of the existing archive action on the viewed agent. */
async function expectArchived(since: number) {
  await waitFor(() =>
    expect(requestsAfter(since, 'DELETE', `/agents/${AGENT_ID}`)).toHaveLength(1),
  );
  // The archived agent was selected: the composer is back on a new agent.
  expect(await screen.findByPlaceholderText('Enter any goal')).toBeInTheDocument();
  expect(bar()).toBeNull();
  expect(await screen.findByText(`Archived "${TITLE}"`)).toBeInTheDocument();
  await waitFor(() => expect(requestsAfter(since, 'GET', '/agents').length).toBeGreaterThan(0));
  await waitFor(() =>
    expect(requestsAfter(since, 'GET', '/attention-requests').length).toBeGreaterThan(0),
  );
}

describe('Task Completed bar: archive', () => {
  it('Archive Agent archives the agent through the existing archive path', async () => {
    serveAgent(agent());
    const user = await renderAgent();
    const since = capturedRequests.length;
    await user.click(within(await screen.findByTestId('task-completed-bar')).getByRole('button'));
    await expectArchived(since);
  });

  it('matches the Rose sidebar menu archive of the same agent (control)', async () => {
    serveAgent(agent());
    const user = await renderAgent();
    await screen.findByTestId('task-completed-bar');
    const since = capturedRequests.length;
    fireEvent.contextMenu(await screen.findByTestId(`rose-agent-row-${AGENT_ID}`));
    const menu = await screen.findByTestId('rose-agent-menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Archive agent' }));
    await expectArchived(since);
  });

  it('a failed archive toasts the existing error and keeps the agent open', async () => {
    server.use(
      http.delete(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    serveAgent(agent());
    const user = await renderAgent();
    await user.click(
      within(await screen.findByTestId('task-completed-bar')).getByRole('button', {
        name: 'Archive Agent',
      }),
    );
    expect(await screen.findByText('Failed to archive agent')).toBeInTheDocument();
    expect(bar()).not.toBeNull();
    expect(screen.getByPlaceholderText('Type your message...')).toBeInTheDocument();
  });
});
