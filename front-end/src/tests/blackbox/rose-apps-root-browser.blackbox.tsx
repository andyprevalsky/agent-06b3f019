/**
 * Blackbox tests for the Browser drawer's Root browser and world state (plan
 * row A6), on the real backend contract (back-end/src/domains/browser-world):
 *
 *   GET  /browser-world/root?agent_id=  {root|null, sites, default_url}  Root tab, drawer open only
 *   POST /browser-world/root/open       {start_url?} -> {root} quiet "Open browser", or once
 *                                       at the selected agent tree's default_url (row 87)
 *   POST /browser-world/root/close      -> {root:null, world_state} merge receipt
 *   GET  /browser-world/sites           {sites}                "Sites" list shown only
 *   DELETE /browser-world/sites/:site   {forgotten}            inline confirm
 *   GET  /browser-world/agents/:agentId {agent_id, tasks}      the shown agent tab only
 *   take over / hand back on Root: existing /browser-session/task/:taskId/{live-view,control}
 *
 * 10k-agent rule: no request while the drawer is closed, no polling while it
 * is open, per-agent reads only for the shown agent. Flag off: no reads at all.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import BrowserStatusBar from '@/features/terminal-component-group/components/BrowserStatusBar';
import { BrowserSitesPanel } from '@/features/terminal-component-group/components/rose-apps/BrowserSitesPanel';
import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';
import {
  agentSiteLines,
  cookieCountText,
  lastWriterText,
  receiptText,
  updatedText,
} from '@/features/terminal-component-group/components/rose-apps/browserWorldView';
import { RECEIPT_VISIBLE_MS } from '@/features/terminal-component-group/components/rose-apps/useBrowserWorld';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import type { Message } from '@/lib/api';
import type {
  AgentBrowserTaskView,
  ForkView,
  RootBrowserView,
  RootSiteView,
} from '@/lib/api/browser-world';

import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

const API = 'http://localhost:3001/api';
const WORLD = `${API}/browser-world`;
const WRAPPER_CLASS = /\b(border|bg-|rounded|ring|shadow)/;
const BOUND_URL = 'https://live.example/root-bound';

const ROOT: RootBrowserView = {
  task_id: 'root-task',
  session_id: 'sess-root',
  status: 'ACTIVE',
  provider: 'kernel',
  live_view_url: 'https://live.example/root-transcript',
  forked_sites: 2,
  live_view_path: '/api/browser-session/task/root-task/live-view',
  control_path: '/api/browser-session/task/root-task/control',
};

const ACTION: Message = {
  message_id: 'm-1',
  timestamp: '2026-01-01T00:00:00Z',
  text: '',
  role: 'TOOL',
  metadata: { task_id: 'task-1', action_type: 'click', title: 'Clicking around' },
};

function agentContext(agentId: string): AgentContextValue {
  return {
    agent: null,
    applyAgentDetail: vi.fn(() => true),
    selectedAgentId: agentId,
    setSelectedAgentId: vi.fn(),
    messages: [ACTION],
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

function agentBrowser(agentId = 'agent-a') {
  return (
    <AgentContext.Provider value={agentContext(agentId)}>
      <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />
    </AgentContext.Provider>
  );
}

/** "METHOD /path" of every browser-world request so far. */
function worldRequests(): string[] {
  return capturedRequests
    .filter((r) => r.url.includes('/browser-world/'))
    .map((r) => `${r.method} ${new URL(r.url).pathname}`);
}

function rootRequests(): string[] {
  return capturedRequests
    .filter((r) => r.url.includes('/browser-session/task/root-task/'))
    .map((r) => `${r.method} ${new URL(r.url).pathname.replace('/api/browser-session/task/', '')}`);
}

/** Let any request a render could start reach MSW. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

function serveRoot(root: () => RootBrowserView | null, sites: RootSiteView[] = []) {
  server.use(
    http.get(`${WORLD}/root`, () => HttpResponse.json({ root: root(), sites })),
    http.get(`${API}/browser-session/task/root-task/live-view`, () =>
      HttpResponse.json({
        taskId: 'root-task',
        sessionId: 'sess-root',
        debugUrl: BOUND_URL,
        status: 'ACTIVE',
        live: true,
        asOf: Date.now(),
      }),
    ),
  );
}

async function openBrowserDrawer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('rose-app-browser'));
  const drawer = screen.getByTestId('browser-app-drawer');
  expect(drawer).toHaveAttribute('data-state', 'open');
  return drawer;
}

async function boundRootFrame(pane: HTMLElement) {
  await waitFor(() =>
    expect(within(pane).getByTitle('Root browser')).toHaveAttribute('src', BOUND_URL),
  );
  return within(pane).getByTitle('Root browser');
}

function fork(site: string, state: ForkView['state']): ForkView {
  return {
    site,
    state,
    base_revision: 1,
    merged_revision: state === 'merged' ? 2 : null,
    root_revision: 2,
    forked_at: '2026-10-20T10:00:00.000Z',
    merged_at: state === 'merged' ? '2026-10-20T10:05:00.000Z' : null,
  };
}

function task(taskId: string, sites: ForkView[]): AgentBrowserTaskView {
  return {
    task_id: taskId,
    session_id: `sess-${taskId}`,
    status: 'ACTIVE',
    live_view_url: null,
    live_view_path: `/api/browser-session/task/${taskId}/live-view`,
    control_path: `/api/browser-session/task/${taskId}/control`,
    sites,
  };
}

function site(name: string, extra: Partial<RootSiteView> = {}): RootSiteView {
  return {
    site: name,
    revision: 3,
    cookie_count: 12,
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    last_writer: { kind: 'root', task_id: 'root-task', agent_id: null },
    ...extra,
  };
}

function receiptSite(name: string, outcome: 'merged' | 'unchanged' | 'stale') {
  return {
    site: name,
    outcome,
    base_revision: 1,
    head_revision: 2,
    merged_revision: outcome === 'merged' ? 2 : null,
  };
}

describe('Browser drawer: Root browser (A6)', () => {
  beforeEach(() => mockSession());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('makes no browser-world request while closed; opening reads Root once, no polling', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <RoseAppIcons />
        {agentBrowser()}
      </>,
    );
    await settle();
    // The agent's status bar is mounted (its tab exists) but the drawer is closed.
    expect(worldRequests()).toEqual([]);

    await openBrowserDrawer(user);
    await waitFor(() => expect(worldRequests()).toEqual(['GET /api/browser-world/root']));
    await settle();
    expect(worldRequests()).toEqual(['GET /api/browser-world/root']);

    // Closing the drawer stops every read; nothing arrives afterwards.
    await user.click(screen.getByTestId('rose-app-browser'));
    expect(screen.getByTestId('browser-app-drawer')).toHaveAttribute('data-state', 'closed');
    const before = capturedRequests.length;
    await settle();
    expect(capturedRequests.slice(before).filter((r) => r.url.includes('/browser-world/'))).toEqual(
      [],
    );
  });

  it('Root closed: a quiet "Open browser" opens Root and frames its bound live view', async () => {
    let root: RootBrowserView | null = null;
    const opened: unknown[] = [];
    serveRoot(() => root);
    server.use(
      http.post(`${WORLD}/root/open`, async ({ request }) => {
        opened.push(await request.json());
        root = ROOT;
        return HttpResponse.json({ root: ROOT });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    const drawer = await openBrowserDrawer(user);

    const open = await within(drawer).findByRole('button', { name: 'Open browser' });
    expect(open.className).not.toMatch(WRAPPER_CLASS);
    expect(within(drawer).getByTestId('root-browser-empty')).toHaveTextContent('Your browser');
    expect(within(drawer).getByTestId('browser-tab-root')).toHaveAttribute('aria-selected', 'true');
    await user.click(open);

    const pane = await within(drawer).findByTestId('root-browser-pane');
    expect(opened).toEqual([{}]);
    // The existing live-view path binds the frame to the task's current session.
    await boundRootFrame(pane);
    expect(rootRequests()).toContain('GET root-task/live-view');
    // View only until the user takes over; Root has no agent to animate.
    expect(within(pane).getByText('View only')).toBeInTheDocument();
    expect(within(pane).queryByText('Agent in progress')).toBeNull();
    expect(within(pane).getByRole('button', { name: 'Close browser' }).className).not.toMatch(
      WRAPPER_CLASS,
    );
    expect(within(drawer).queryByTestId('root-browser-empty')).toBeNull();
  });

  it('takes over and hands back Root through the existing control route', async () => {
    const modes: string[] = [];
    serveRoot(() => ROOT);
    server.use(
      http.post(`${API}/browser-session/task/root-task/control`, async ({ request }) => {
        const body = (await request.json()) as { mode: string };
        modes.push(body.mode);
        return HttpResponse.json({
          state: body.mode === 'user' ? 'user' : 'agent',
          agentPaused: false,
          debugUrl: BOUND_URL,
        });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    const drawer = await openBrowserDrawer(user);
    const pane = await within(drawer).findByTestId('root-browser-pane');
    expect(await boundRootFrame(pane)).toHaveAttribute('inert');

    await user.click(within(pane).getByRole('button', { name: 'Take control' }));
    await within(pane).findByRole('button', { name: 'Hand back control' });
    const frame = within(pane).getByTitle('Root browser');
    expect(frame).not.toHaveAttribute('inert');
    expect(frame.getAttribute('src')).toContain('interactive=true');
    expect(within(pane).getAllByText('You have control').length).toBeGreaterThan(0);

    await user.click(within(pane).getByRole('button', { name: 'Hand back control' }));
    await within(pane).findByRole('button', { name: 'Take control' });
    expect(modes).toEqual(['user', 'agent']);
    expect(rootRequests()).toContain('GET root-task/control');
  });

  it('closing Root shows the merge receipt briefly, then offers Open browser again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let root: RootBrowserView | null = ROOT;
    let closes = 0;
    serveRoot(() => root);
    server.use(
      http.post(`${WORLD}/root/close`, () => {
        closes += 1;
        root = null;
        return HttpResponse.json({
          root: null,
          world_state: {
            task_id: 'root-task',
            kind: 'root',
            sites: [receiptSite('github.com', 'merged'), receiptSite('x.com', 'unchanged')],
          },
        });
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<RoseAppIcons />);
    const drawer = await openBrowserDrawer(user);
    const pane = await within(drawer).findByTestId('root-browser-pane');

    await user.click(within(pane).getByRole('button', { name: 'Close browser' }));
    const receipt = await within(drawer).findByTestId('root-browser-receipt');
    expect(receipt).toHaveTextContent('Saved logins for github.com');
    expect(receipt.className).not.toMatch(WRAPPER_CLASS);
    expect(closes).toBe(1);
    expect(within(drawer).queryByTestId('root-browser-pane')).toBeNull();
    // The close merged sites into Root: Root is read again once.
    await waitFor(() =>
      expect(worldRequests().filter((r) => r === 'GET /api/browser-world/root')).toHaveLength(2),
    );
    expect(await within(drawer).findByRole('button', { name: 'Open browser' })).toBeEnabled();

    act(() => {
      vi.advanceTimersByTime(RECEIPT_VISIBLE_MS);
    });
    await waitFor(() => expect(within(drawer).queryByTestId('root-browser-receipt')).toBeNull());
  });

  it('Reload is dimmed while Root is closed and remounts the open Root live view', async () => {
    let root: RootBrowserView | null = null;
    serveRoot(() => root);
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<RoseAppIcons />);
    let drawer = await openBrowserDrawer(user);
    await within(drawer).findByRole('button', { name: 'Open browser' });
    expect(within(drawer).getByRole('button', { name: 'Reload' })).toBeDisabled();
    unmount();

    root = ROOT;
    renderWithProviders(<RoseAppIcons />);
    drawer = await openBrowserDrawer(user);
    const pane = await within(drawer).findByTestId('root-browser-pane');
    await boundRootFrame(pane);
    const reload = within(drawer).getByRole('button', { name: 'Reload' });
    expect(reload).toBeEnabled();
    const before = within(pane).getByTestId('live-view-pane');
    await user.click(reload);
    const after = within(drawer).getByTestId('live-view-pane');
    expect(after).not.toBe(before);
    expect(before.isConnected).toBe(false);
  });

  it('reports a Root read or open failure as quiet text and keeps Open browser', async () => {
    server.use(
      http.get(`${WORLD}/root`, () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
      http.post(`${WORLD}/root/open`, () =>
        HttpResponse.json({ error: 'Failed to open Root browser' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    const drawer = await openBrowserDrawer(user);
    expect(await within(drawer).findByText('Couldn’t reach your browser.')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Open browser' }));
    expect(
      await within(drawer).findByText('Couldn’t open your browser. Try again.'),
    ).toBeInTheDocument();
    expect(within(drawer).queryByTestId('root-browser-pane')).toBeNull();
  });
});

describe('Browser drawer: agent world state and Root sites (A6)', () => {
  beforeEach(() => mockSession());
  afterEach(() => localStorage.clear());

  it('does not add a separate per-site row or fetch agent world state in the compact drawer', async () => {
    server.use(
      http.get(`${WORLD}/agents/:agentId`, ({ params }) =>
        HttpResponse.json({
          agent_id: params.agentId,
          tasks: [
            task('task-1', [
              fork('github.com', 'forked'),
              fork('google.com', 'merged'),
              fork('x.com', 'stale'),
              fork('y.com', 'signed_out'),
              fork('z.com', 'no_login'),
            ]),
            task('task-0', [fork('other.com', 'forked')]),
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(agentBrowser('agent-a'));
    await settle();
    expect(worldRequests()).toEqual([]);

    await user.click(screen.getByTitle('Preview').parentElement!);
    const drawer = screen.getByTestId('browser-app-drawer');
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'open'));
    expect(within(drawer).queryByTestId('browser-agent-sites')).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Sites' })).toBeNull();
    await settle();
    expect(worldRequests().filter((r) => r.includes('/agents/'))).toEqual([]);

    // The Root tab hides the agent's state.
    await user.click(within(drawer).getByTestId('browser-tab-root'));
    expect(within(drawer).queryByTestId('browser-agent-sites')).toBeNull();
  });

  it('the standalone Sites panel retains confirmation and deletion without adding a drawer toolbar', async () => {
    const deleted: string[] = [];
    server.use(
      http.get(`${WORLD}/sites`, () =>
        HttpResponse.json({
          sites: [
            site('github.com'),
            site('google.com', {
              cookie_count: 1,
              last_writer: { kind: 'agent', task_id: 'task-9', agent_id: 'agent-zz' },
            }),
          ],
        }),
      ),
      http.delete(`${WORLD}/sites/:site`, ({ params }) => {
        deleted.push(String(params.site));
        return HttpResponse.json({ forgotten: true });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    const drawer = await openBrowserDrawer(user);
    await settle();
    expect(worldRequests()).not.toContain('GET /api/browser-world/sites');

    expect(within(drawer).queryByRole('button', { name: 'Sites' })).toBeNull();
    const panel = renderWithProviders(<BrowserSitesPanel agentTitle={() => null} />);
    const github = await screen.findByTestId('browser-site-github.com');
    expect(github).toHaveTextContent('github.com');
    expect(github).toHaveTextContent('12 cookies · 5 min ago · by Root');
    expect(screen.getByTestId('browser-site-google.com')).toHaveTextContent(
      '1 cookie · 5 min ago · by an agent',
    );

    await user.click(within(github).getByRole('button', { name: 'Forget github.com' }));
    const confirm = within(github).getByRole('group', { name: 'Confirm forgetting github.com' });
    expect(confirm).toHaveTextContent('Forget github.com? Agents lose this login.');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(deleted).toEqual([]);

    await user.click(within(github).getByRole('button', { name: 'Forget github.com' }));
    await user.click(
      within(within(github).getByRole('group')).getByRole('button', { name: 'Forget' }),
    );
    await waitFor(() => expect(deleted).toEqual(['github.com']));
    await waitFor(() => expect(screen.queryByTestId('browser-site-github.com')).toBeNull());
    expect(screen.getByTestId('browser-site-google.com')).toBeInTheDocument();

    panel.unmount();
    expect(screen.queryByTestId('browser-sites-panel')).toBeNull();
  });

  it('flag off: even an opened drawer reads no browser world and offers no Sites', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />, { roseDesktop: false });
    const drawer = await openBrowserDrawer(user);
    await settle();
    expect(worldRequests()).toEqual([]);
    expect(within(drawer).queryByRole('button', { name: 'Sites' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Open browser' })).toBeNull();
  });
});

describe('browser world text', () => {
  it('reads per-site state from the shown task, else the newest entry per site', () => {
    const tasks = [
      task('task-2', [fork('github.com', 'merged'), fork('a.com', 'no_login_signal')]),
      task('task-1', [fork('github.com', 'forked'), fork('b.com', 'unchanged')]),
    ];
    expect(agentSiteLines(tasks, 'task-1').map((l) => l.text)).toEqual([
      'forked github.com',
      'b.com unchanged',
    ]);
    expect(agentSiteLines(tasks, 'unknown')).toEqual([
      { site: 'github.com', text: 'merged login for github.com', muted: false },
      { site: 'a.com', text: 'no login signal on a.com', muted: true },
      { site: 'b.com', text: 'b.com unchanged', muted: true },
    ]);
    expect(agentSiteLines([], null)).toEqual([]);
  });

  it('words the close receipt, last writer, cookie count and update time', () => {
    expect(receiptText(null)).toBe('Browser closed');
    expect(
      receiptText({ task_id: 't', kind: 'root', sites: [receiptSite('x.com', 'stale')] }),
    ).toBe('Browser closed');
    expect(
      receiptText({
        task_id: 't',
        kind: 'root',
        sites: [
          receiptSite('github.com', 'merged'),
          receiptSite('x.com', 'stale'),
          receiptSite('a.com', 'merged'),
        ],
      }),
    ).toBe('Saved logins for github.com, a.com');

    const titles = (id: string) => (id === 'agent-1' ? 'Book flights' : null);
    expect(lastWriterText({ kind: 'root', task_id: null, agent_id: null }, titles)).toBe('by Root');
    expect(lastWriterText({ kind: 'agent', task_id: 't', agent_id: 'agent-1' }, titles)).toBe(
      'by Book flights',
    );
    expect(lastWriterText({ kind: 'agent', task_id: 't', agent_id: null }, titles)).toBe(
      'by an agent',
    );
    expect(lastWriterText({ kind: null, task_id: null, agent_id: null }, titles)).toBeNull();

    expect(cookieCountText(1)).toBe('1 cookie');
    expect(cookieCountText(1200)).toBe('1,200 cookies');
    const now = Date.parse('2026-10-20T12:00:00.000Z');
    expect(updatedText('2026-10-20T11:59:40.000Z', now)).toBe('just now');
    expect(updatedText('2026-10-20T11:15:00.000Z', now)).toBe('45 min ago');
    expect(updatedText('2026-10-20T09:00:00.000Z', now)).toBe('3 h ago');
    expect(updatedText('2026-10-18T09:00:00.000Z', now)).toBe('Oct 18');
    expect(updatedText('not a date', now)).toBe('');
  });
});

describe('Browser drawer: Root opens at the selected agent tree default_url (row 87)', () => {
  const AGENT = 'agent-root-1';
  const DEFAULT_URL = 'https://www.opentable.com/r/nopa-san-francisco';

  beforeEach(() => mockSession());
  afterEach(() => localStorage.clear());

  /** GET /root answers default_url only for `?agent_id=`; POST /root/open is recorded. */
  function serveDefaultUrl(options: { defaultUrl: string | null; root?: RootBrowserView }) {
    const reads: (string | null)[] = [];
    const opened: unknown[] = [];
    let root: RootBrowserView | null = options.root ?? null;
    serveRoot(() => root);
    server.use(
      http.get(`${WORLD}/root`, ({ request }) => {
        const agentId = new URL(request.url).searchParams.get('agent_id');
        reads.push(agentId);
        const defaultUrl = agentId === null ? null : options.defaultUrl;
        return HttpResponse.json({ root, sites: [], default_url: defaultUrl });
      }),
      http.post(`${WORLD}/root/open`, async ({ request }) => {
        opened.push(await request.json());
        root = ROOT;
        return HttpResponse.json({ root: ROOT });
      }),
      http.post(`${WORLD}/root/close`, () => {
        root = null;
        return HttpResponse.json({ root: null, world_state: null });
      }),
    );
    return { reads, opened };
  }

  function renderWithAgent(selectedAgentId: string | null, roseDesktop = true) {
    return renderWithProviders(<RoseAppIcons />, { roseDesktop, selectedAgentId });
  }

  it('opening the Browser app with an agent selected starts Root at its tree default_url', async () => {
    const backend = serveDefaultUrl({ defaultUrl: DEFAULT_URL });
    const user = userEvent.setup();
    renderWithAgent(AGENT);
    await settle();
    // Nothing opens Root on its own: no read and no open before the drawer opens.
    expect(worldRequests()).toEqual([]);

    const drawer = await openBrowserDrawer(user);
    const pane = await within(drawer).findByTestId('root-browser-pane');
    expect(backend.reads).toEqual([AGENT]);
    expect(backend.opened).toEqual([{ start_url: DEFAULT_URL }]);
    await boundRootFrame(pane);
    expect(within(drawer).getByTestId('browser-tab-root')).toHaveAttribute('aria-selected', 'true');
    await settle();
    // Opened exactly once and read once: no polling.
    expect(backend.opened).toHaveLength(1);
    expect(backend.reads).toEqual([AGENT]);
  });

  it('with no agent selected it shows the quiet Open browser and opens nothing by itself', async () => {
    const backend = serveDefaultUrl({ defaultUrl: DEFAULT_URL });
    const user = userEvent.setup();
    renderWithAgent(null);
    const drawer = await openBrowserDrawer(user);
    const open = await within(drawer).findByRole('button', { name: 'Open browser' });
    await settle();
    expect(backend.reads).toEqual([null]);
    expect(backend.opened).toEqual([]);
    expect(within(drawer).getByTestId('root-browser-empty')).toHaveTextContent('Your browser');

    await user.click(open);
    await within(drawer).findByTestId('root-browser-pane');
    expect(backend.opened).toEqual([{}]);
  });

  it('an agent whose tree has no default_url yet keeps the quiet Open browser', async () => {
    const backend = serveDefaultUrl({ defaultUrl: null });
    const user = userEvent.setup();
    renderWithAgent(AGENT);
    const drawer = await openBrowserDrawer(user);
    await within(drawer).findByRole('button', { name: 'Open browser' });
    await settle();
    expect(backend.reads).toEqual([AGENT]);
    expect(backend.opened).toEqual([]);
  });

  it('an already open Root is shown as is, never reopened', async () => {
    const backend = serveDefaultUrl({ defaultUrl: DEFAULT_URL, root: ROOT });
    const user = userEvent.setup();
    renderWithAgent(AGENT);
    const drawer = await openBrowserDrawer(user);
    await boundRootFrame(await within(drawer).findByTestId('root-browser-pane'));
    await settle();
    expect(backend.opened).toEqual([]);
  });

  it('closing the opened Root does not reopen it; closing the drawer stops all reads', async () => {
    const backend = serveDefaultUrl({ defaultUrl: DEFAULT_URL });
    const user = userEvent.setup();
    renderWithAgent(AGENT);
    const drawer = await openBrowserDrawer(user);
    const pane = await within(drawer).findByTestId('root-browser-pane');
    await user.click(within(pane).getByRole('button', { name: 'Close browser' }));
    await within(drawer).findByRole('button', { name: 'Open browser' });
    await settle();
    expect(backend.opened).toHaveLength(1);

    await user.click(screen.getByTestId('rose-app-browser'));
    expect(screen.getByTestId('browser-app-drawer')).toHaveAttribute('data-state', 'closed');
    const before = capturedRequests.length;
    await settle();
    expect(capturedRequests.slice(before).filter((r) => r.url.includes('/browser-world/'))).toEqual(
      [],
    );
  });

  it('flag off: an agent selected and the drawer opened reads and opens nothing', async () => {
    const backend = serveDefaultUrl({ defaultUrl: DEFAULT_URL });
    const user = userEvent.setup();
    renderWithAgent(AGENT, false);
    await user.click(screen.getByTestId('rose-app-browser'));
    await settle();
    expect(backend.reads).toEqual([]);
    expect(backend.opened).toEqual([]);
  });
});
