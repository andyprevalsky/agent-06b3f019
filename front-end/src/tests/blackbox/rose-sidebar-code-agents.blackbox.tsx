/**
 * Blackbox tests for code agents (Claude Code / Codex sessions) in the Rose
 * Desktop left bar, on the W5b batched contract (feat/rose-user-ui @ f78bf8aa8,
 * back-end/src/domains/agents/routes.codeAgents.ts):
 *
 *   GET /api/agents/code-agents?root_ids=<1-50 comma-separated ids>
 *     → { code_agents: [{ code_agent_id, owner_agent_id, root_agent_id,
 *                         provider ('claude' | 'codex' | null), status, title, created_at }] }
 *     400 above 50 ids; at most 500 rows.
 *
 * 10k agents: one request per page of ≤50 roots that has a row on screen (or
 * the selected row), never per row; nothing is read or polled while no root is
 * on screen; only an on-screen running root re-reads (every 30s). The MSW mock
 * rejects >50 ids like the server. Rows are on screen per a controllable
 * IntersectionObserver (jsdom has none). Flag off reads nothing.
 *
 * A running code-agent row has its provider icon + title and a Working badge
 * at the icon's top right. Inactive rows fold into the owner's Finished agents
 * drawer and retain only their provider icon (no check, x or alert).
 *
 * With the CodeAgentViewProvider (as TerminalContent mounts it) a row opens
 * that code agent's own conversation: the row is marked (color/weight), its
 * owner row is not; any agent row (the owner without a reload) returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { CodeAgentViewProvider } from '@/features/terminal-component-group/components/code-agent-view/CodeAgentViewProvider';
import { AttentionRequestsContext } from '@/features/terminal-component-group/components/attention-inbox/attentionRequestsContext';
import type { Agent, AttentionRequest } from '@/lib/api';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';
import {
  expandBar,
  makeProject,
  mockProjectsApi,
  roseBar,
  signedInUser,
} from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';
import {
  AGENTS,
  ROWS,
  RUNNING,
  bulkAgents,
  codeAgent,
  codeAgentQuestion,
  createdMinutesAgo,
  mockCodeAgents,
} from './rose-sidebar-code-agents.fixtures';

vi.mock('@/lib/realtime', async (original) => ({
  ...(await original<typeof import('@/lib/realtime')>()),
  subscribeToBus: vi.fn(async () => ({ state: 'joined' })),
  unsubscribe: vi.fn(),
}));

const API_BASE = 'http://localhost:3001/api';
// ─── On-screen control (one shared observer per bar) ────────────────────────

let onScreen: (agentId: string) => boolean = () => true;
const observers = new Set<ControlledIntersectionObserver>();

function rowAgentId(el: Element): string {
  return (el as HTMLElement).dataset.testid?.replace(/^rose-agent-row-/, '') ?? '';
}

/** Reports observed agent rows on screen per `onScreen`; `rescan()` simulates a scroll. */
class ControlledIntersectionObserver {
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
    this.report([target]);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
  takeRecords() {
    return [];
  }
  report(targets: Element[]) {
    const entries = targets.map(
      (target) =>
        ({ target, isIntersecting: onScreen(rowAgentId(target)) }) as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

function scrollTo(next: (agentId: string) => boolean) {
  onScreen = next;
  act(() => {
    for (const observer of observers) observer.report([...observer.targets]);
  });
}

const originalIntersectionObserver = window.IntersectionObserver;

// ─── Backend mock (strict like routes.codeAgents.ts) ────────────────────────

function codeAgentRequests(): string[][] {
  return capturedRequests
    .filter((r) => r.method === 'GET' && new URL(r.url).pathname === '/api/agents/code-agents')
    .map((r) => (new URL(r.url).searchParams.get('root_ids') ?? '').split(','));
}

function treeRequests() {
  return capturedRequests.filter((r) => new URL(r.url).pathname === '/api/agents/tree');
}

function renderBar(
  overrides: Parameters<typeof defaultProps>[0] = {},
  { dark = false, attention = [] as AttentionRequest[] } = {},
) {
  const user = signedInUser();
  if (dark) localStorage.setItem(`rose-theme:${user.id}`, 'dark');
  // The app-wide attention subscription, as TerminalContent provides it.
  return renderWithProviders(
    <AttentionRequestsContext.Provider value={{ requests: attention, refetch: async () => {} }}>
      <AppSidebar {...defaultProps({ agents: AGENTS, user, ...overrides })} />
    </AttentionRequestsContext.Provider>,
    { roseThemeUserId: user.id },
  );
}

function barRowOrder(): string[] {
  const groups = screen.getByTestId('rose-agent-groups');
  return [
    ...groups.querySelectorAll<HTMLElement>(
      '[data-testid^="rose-agent-row-"], [data-testid^="rose-code-agent-row-"], [data-testid^="rose-project-row-"]',
    ),
  ].map((el) => el.dataset.testid!.replace(/^rose-(agent|code-agent|project)-row-/, '$1:'));
}

function ids(agents: Agent[]): Set<string> {
  return new Set(agents.map((agent) => agent.agent_id));
}

beforeEach(() => {
  localStorage.clear();
  mockSession();
  clearCaptures();
  onScreen = () => true;
  window.IntersectionObserver =
    ControlledIntersectionObserver as unknown as typeof window.IntersectionObserver;
  mockProjectsApi([makeProject(), makeProject({ id: 'p-habits', name: 'Habits' })]);
  mockCodeAgents(ROWS);
  server.use(
    http.get(`${API_BASE}/agents/tree`, ({ request }) =>
      HttpResponse.json({
        agents:
          new URL(request.url).searchParams.get('busId') === 'rose-run'
            ? [
                {
                  agent_id: 'rose-sub',
                  parent_agent_id: 'rose-run',
                  goal: 'Research implementation',
                  status: 'COMPLETED',
                  progress: 1,
                  tools_in_use: [],
                  message_count: 1,
                  tree_cost_cents: 0,
                },
              ]
            : [],
      }),
    ),
  );
});

afterEach(() => {
  window.IntersectionObserver = originalIntersectionObserver;
  observers.clear();
  vi.useRealTimers();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

async function openCodeRow(id: string) {
  expandBar();
  const bulk = /^cc-(\d+)$/.exec(id);
  const root = bulk ? `bulk-${bulk[1]}` : id === 'cc-sub' ? 'rose-run' : 'home-run';
  const owner = id === 'cc-sub' ? 'rose-sub' : root;
  if (root === 'rose-run') await screen.findByTestId('rose-project-row-p-rose');
  for (const agentId of new Set([root, owner])) {
    if (!screen.queryByTestId(`rose-agent-row-${agentId}`)) {
      const finished = within(screen.getByTestId(`rose-agent-children-${root}`)).getByRole(
        'button',
        { name: /^Finished agents/ },
      );
      if (finished.getAttribute('aria-expanded') === 'false') fireEvent.click(finished);
    }
    const row = await screen.findByTestId(`rose-agent-row-${agentId}`);
    const wrapper = row.closest('[data-agent-depth]') as HTMLElement;
    const toggle = await within(wrapper).findByRole('button', { name: /^Expand|^Collapse/ });
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  }
  if (!screen.queryByTestId(`rose-code-agent-row-${id}`)) {
    const finished = within(screen.getByTestId(`rose-agent-children-${owner}`)).queryByRole(
      'button',
      { name: /^Finished agents/ },
    );
    if (finished?.getAttribute('aria-expanded') === 'false') fireEvent.click(finished);
  }
  return screen.findByTestId(`rose-code-agent-row-${id}`);
}

describe('Rose left bar code agents (flag on)', () => {
  it.each(['claude', 'codex'] as const)(
    'badges a running %s icon in its top-right corner and folds inactive sessions away',
    async (provider) => {
      mockCodeAgents([
        codeAgent({ code_agent_id: 'running', provider, title: 'Running' }),
        codeAgent({ code_agent_id: 'paused', provider, status: 'PAUSED', title: 'Paused' }),
        codeAgent({
          code_agent_id: 'stopped',
          provider,
          container_state: 'stopped',
          title: 'Stopped',
        }),
        codeAgent({ code_agent_id: 'done', provider, status: 'COMPLETED', title: 'Done' }),
        codeAgent({ code_agent_id: 'closed', provider, status: 'CLOSED', title: 'Closed' }),
        codeAgent({ code_agent_id: 'error', provider, status: 'ERROR', title: 'Error' }),
        codeAgent({
          code_agent_id: 'waiting',
          provider,
          awaiting_parent: { question: 'Review this?', at: '2026-10-20T12:00:00Z' },
          title: 'Waiting',
        }),
      ]);
      renderBar();
      expect(await screen.findByTestId('rose-agent-count-home-run')).toHaveTextContent('2');
      expandBar();
      fireEvent.click(await screen.findByRole('button', { name: 'Expand Plan Tahoe trip' }));
      const row = await screen.findByTestId('rose-code-agent-row-running');
      const working = within(row).getByRole('img', { name: 'Working' });
      expect(working.parentElement).toHaveClass('absolute', '-right-1.5', '-top-1');
      expect(working.parentElement?.parentElement).toHaveClass('relative');
      expect(row).toHaveAttribute('data-provider', provider);
      for (const id of ['paused', 'stopped', 'done', 'closed', 'error', 'waiting']) {
        expect(screen.queryByTestId(`rose-code-agent-row-${id}`)).toBeNull();
      }
      const drawer = within(screen.getByTestId('rose-agent-children-home-run')).getByRole(
        'button',
        { name: 'Finished agents (6)' },
      );
      expect(drawer).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(drawer);
      for (const id of ['paused', 'stopped', 'done', 'closed', 'error', 'waiting']) {
        expect(
          within(screen.getByTestId(`rose-code-agent-row-${id}`)).queryByRole('img', {
            name: 'Working',
          }),
        ).toBeNull();
      }
      fireEvent.click(drawer);
      expect(screen.queryByTestId('rose-code-agent-row-paused')).toBeNull();
    },
  );

  it('moves a coding session between the list and drawer as its live page pauses and resumes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [
      codeAgent({ code_agent_id: 'cc-live', provider: 'codex', title: 'Live session' }),
    ];
    mockCodeAgents(rows);
    renderBar();
    expect(await openCodeRow('cc-live')).toBeInTheDocument();
    rows[0].status = 'PAUSED';
    await act(() => vi.advanceTimersByTimeAsync(30_500));
    await waitFor(() => expect(screen.queryByTestId('rose-code-agent-row-cc-live')).toBeNull());
    const children = within(screen.getByTestId('rose-agent-children-home-run'));
    expect(children.getByRole('button', { name: 'Finished agents (1)' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    rows[0].status = 'ACTIVE';
    await act(() => vi.advanceTimersByTimeAsync(30_500));
    const resumed = await screen.findByTestId('rose-code-agent-row-cc-live');
    expect(within(resumed).getByRole('img', { name: 'Working' })).toBeInTheDocument();
    expect(children.queryByRole('button', { name: /^Finished agents/ })).toBeNull();
  });

  it('code-agent pages follow display order: project agents (on top) share the first page', async () => {
    const home = bulkAgents(50, () => ({ project_id: null }));
    const projectAgent = makeAgent({
      agent_id: 'rose-proj',
      goal: 'Project work',
      status: 'COMPLETED',
      project_id: 'p-rose',
      ...createdMinutesAgo(500),
    });
    onScreen = (id) => id === 'rose-proj';
    renderBar({ agents: [...home, projectAgent] });
    // With Projects on top, rose-proj is row 1: its page is the first 50 rows,
    // not a page of its own after the 50 Home agents.
    await waitFor(() =>
      expect(
        codeAgentRequests().some((page) => page.length === 50 && page.includes('rose-proj')),
      ).toBe(true),
    );
  });

  it("one batched request lists each tree's code agents under its root row, oldest first", async () => {
    renderBar();
    expandBar();
    await openCodeRow('cc-sub');
    await openCodeRow('cc-fix');
    expect(barRowOrder()).toEqual([
      'project:p-rose',
      'agent:rose-run',
      'agent:rose-sub',
      'code-agent:cc-sub',
      'agent:rose-fail',
      'project:p-habits',
      'agent:habits-done',
      'agent:home-run',
      'code-agent:cc-build',
      'code-agent:cc-fix',
      'agent:orphan',
      'agent:home-done',
    ]);
    expect(codeAgentRequests()).toHaveLength(1);
    expect(new Set(codeAgentRequests()[0])).toEqual(new Set(AGENTS.map((a) => a.agent_id)));
    expect(new Set(treeRequests().map((r) => new URL(r.url).searchParams.get('busId')))).toEqual(
      ids(AGENTS),
    );
    // Initially ungrouped roots can remount once when their projects arrive.
    expect(treeRequests().length).toBeLessThanOrEqual(AGENTS.length * 2);
    // One level under the parent: Home is a project too (Andy, 2026-10-28), so
    // Home and project agent rows both sit at 34px and their children one level in.
    expect(screen.getByTestId('rose-code-agent-row-cc-build')).toHaveStyle({ paddingLeft: '50px' });
    expect(screen.getByTestId('rose-code-agent-row-cc-sub')).toHaveStyle({ paddingLeft: '66px' });
    expect(screen.getByTestId('rose-code-agent-row-cc-build')).toHaveTextContent(
      'Build the widget',
    );
  });

  it('uses the Claude / Codex icon instead of the Bot glyph: icon + title only', async () => {
    renderBar({}, { dark: true });
    const row = (id: string) => screen.getByTestId(`rose-code-agent-row-${id}`);
    await openCodeRow('cc-sub');
    await openCodeRow('cc-fix');
    for (const id of ['cc-build', 'cc-fix', 'cc-sub']) {
      expect(row(id).querySelector('[data-sidebar-agent-icon], svg.lucide-bot')).toBeNull();
    }
    expect(within(row('cc-build')).getByRole('img', { name: 'Claude Code' })).toBeInTheDocument();
    expect(within(row('cc-fix')).getByRole('img', { name: 'Codex' })).toBeInTheDocument();
    // Legacy provider null defaults to Claude.
    expect(row('cc-sub')).toHaveAttribute('data-provider', 'claude');
    expect(within(row('cc-sub')).getByRole('img', { name: 'Claude Code' })).toBeInTheDocument();
    expect(row('cc-sub').className).toContain('dark:text-[#a3a39d]');
    expect(row('cc-fix')).toHaveTextContent('Fix flaky test');
  });

  it('collapsed: children stay hidden inside their root and only active agents contribute to the badge', async () => {
    renderBar();
    await waitFor(() => expect(codeAgentRequests()).toHaveLength(1));
    expect(roseBar()).toHaveAttribute('data-expanded', 'false');
    expect(screen.queryByTestId('rose-code-agent-row-cc-build')).toBeNull();
    expect(await screen.findByTestId('rose-agent-count-home-run')).toHaveTextContent('2');
    expect(screen.queryByTestId('rose-agent-count-rose-run')).toBeNull();
    expect(screen.getAllByTestId('rose-group-divider')).toHaveLength(2);
  });

  it('clicking a code agent opens its owner conversation; a provided handler replaces that', async () => {
    const user = userEvent.setup();
    const onSelectAgent = vi.fn();
    const { unmount } = renderBar({ onSelectAgent });
    await user.click(await openCodeRow('cc-sub'));
    expect(onSelectAgent).toHaveBeenCalledWith('rose-sub');
    unmount();

    const onOpenCodeAgent = vi.fn();
    renderBar({ roseActions: { onOpenCodeAgent } });
    await user.click(await openCodeRow('cc-fix'));
    expect(onOpenCodeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        code_agent_id: 'cc-fix',
        owner_agent_id: 'home-run',
        root_agent_id: 'home-run',
        provider: 'codex',
      }),
    );
  });

  it('10k: one request per on-screen page of ≤50 roots; off-screen pages are read on scroll', async () => {
    const many = bulkAgents(130);
    onScreen = (id) => ['bulk-3', 'bulk-48', 'bulk-52'].includes(id);
    mockCodeAgents([
      codeAgent({ code_agent_id: 'cc-3', root_agent_id: 'bulk-3', owner_agent_id: 'bulk-3' }),
      codeAgent({ code_agent_id: 'cc-120', root_agent_id: 'bulk-120', owner_agent_id: 'bulk-120' }),
    ]);
    renderWithProviders(<AppSidebar {...defaultProps({ agents: many, user: signedInUser() })} />);
    await openCodeRow('cc-3');
    await waitFor(() => expect(codeAgentRequests()).toHaveLength(2));
    // Display order is newest first (bulk-0 … bulk-129); pages are 50 roots each.
    const [first, second] = codeAgentRequests();
    expect(new Set(first)).toEqual(ids(many.slice(0, 50)));
    expect(new Set(second)).toEqual(ids(many.slice(50, 100)));
    expect(screen.queryByTestId('rose-code-agent-row-cc-120')).toBeNull();

    scrollTo((id) => id === 'bulk-120');
    await openCodeRow('cc-120');
    expect(codeAgentRequests()).toHaveLength(3);
    expect(new Set(codeAgentRequests()[2])).toEqual(ids(many.slice(100)));
    expect(codeAgentRequests().every((page) => page.length <= 50)).toBe(true);
    // Rows of pages read earlier stay listed (no layout shift) and are not re-read.
    expect(screen.getByTestId('rose-code-agent-row-cc-3')).toBeInTheDocument();
    scrollTo((id) => id === 'bulk-3');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(codeAgentRequests()).toHaveLength(3);
    expect(treeRequests().length).toBeLessThanOrEqual(5);
  });

  it('nothing on screen and nothing selected: no request at all', async () => {
    onScreen = () => false;
    renderWithProviders(
      <AppSidebar {...defaultProps({ agents: bulkAgents(80), user: signedInUser() })} />,
    );
    await screen.findByTestId('rose-agent-row-bulk-0');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(codeAgentRequests()).toHaveLength(0);
  });

  it("the selected row's page is read even while it is off screen", async () => {
    onScreen = () => false;
    const many = bulkAgents(80);
    renderWithProviders(
      <AppSidebar
        {...defaultProps({ agents: many, user: signedInUser(), selectedAgentId: 'bulk-70' })}
      />,
    );
    await waitFor(() => expect(codeAgentRequests()).toHaveLength(1));
    expect(new Set(codeAgentRequests()[0])).toEqual(ids(many.slice(50)));
  });

  it('only an on-screen running root re-reads every 30s; finished or off-screen roots never poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // bulk-30 runs (sorted first, page 0); bulk-0 on page 0 is finished.
    const many = bulkAgents(60, (i) => (i === 30 ? RUNNING : {}));
    onScreen = (id) => id === 'bulk-0';
    renderWithProviders(<AppSidebar {...defaultProps({ agents: many, user: signedInUser() })} />);
    await waitFor(() => expect(codeAgentRequests()).toHaveLength(1));
    expect(codeAgentRequests()[0]).toContain('bulk-30');
    // The running root is off screen: no polling.
    await act(() => vi.advanceTimersByTimeAsync(65_000));
    expect(codeAgentRequests()).toHaveLength(1);

    scrollTo((id) => id === 'bulk-30');
    await act(() => vi.advanceTimersByTimeAsync(30_500));
    await waitFor(() => expect(codeAgentRequests()).toHaveLength(2));
    expect(new Set(codeAgentRequests()[1])).toEqual(new Set(codeAgentRequests()[0]));

    // Scrolled away: nothing on screen, nothing polls.
    scrollTo(() => false);
    await act(() => vi.advanceTimersByTimeAsync(65_000));
    expect(codeAgentRequests()).toHaveLength(2);
  });

  it('flag off: the stock sidebar reads no code agents and shows none', async () => {
    renderWithProviders(
      <AppSidebar {...defaultProps({ agents: AGENTS, user: signedInUser() })} />,
      { roseDesktop: false },
    );
    await waitFor(() => expect(screen.getByLabelText('Resize sidebar')).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('rose-code-agent-row-cc-build')).toBeNull();
    expect(codeAgentRequests()).toHaveLength(0);
    expect(treeRequests()).toHaveLength(0);
  });
});

describe('code-agent rows show a Working badge only while running (flag on)', () => {
  /** Every image in a row: provider, and Working only when running. */
  const rowImages = (id: string) =>
    within(screen.getByTestId(`rose-code-agent-row-${id}`))
      .queryAllByRole('img')
      .map((img) => img.getAttribute('aria-label') ?? img.getAttribute('alt'));

  function expectIconOnly(id: string, provider: 'Claude Code' | 'Codex', running = false) {
    const row = screen.getByTestId(`rose-code-agent-row-${id}`);
    expect(rowImages(id)).toEqual(running ? [provider, 'Working'] : [provider]);
    // No check, x, alert, spinner or thinking.svg bubble.
    expect(row.querySelectorAll('svg')).toHaveLength(0);
    expect(row.querySelectorAll('img')).toHaveLength(1);
    expect(within(row).queryByTestId('rose-code-agent-thinking')).toBeNull();
  }

  it.each([
    ['light', false],
    ['dark', true],
  ])('only running rows add the corner Working badge (%s)', async (_, dark) => {
    renderBar({}, { dark });
    await openCodeRow('cc-sub');
    await openCodeRow('cc-fix');
    expandBar();
    expectIconOnly('cc-build', 'Claude Code', true);
    expectIconOnly('cc-fix', 'Codex');
    expectIconOnly('cc-sub', 'Claude Code');
  });

  it('an ACTIVE task retains its running badge until the session reports it is waiting', async () => {
    renderBar({}, { attention: [codeAgentQuestion('cc-build')] });
    await openCodeRow('cc-build');
    expectIconOnly('cc-build', 'Claude Code', true);
  });

  it('a paused (CLOSED) session shows no glyph either', async () => {
    mockCodeAgents([codeAgent({ code_agent_id: 'cc-paused', status: 'CLOSED', title: 'Paused' })]);
    renderBar();
    await openCodeRow('cc-paused');
    expectIconOnly('cc-paused', 'Claude Code');
  });

  it('agent (robot) rows keep their status glyphs', async () => {
    renderBar({}, { dark: true });
    await openCodeRow('cc-fix');
    expect(
      within(screen.getByTestId('rose-agent-row-home-done')).getByRole('img', {
        name: 'Completed',
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('rose-agent-row-rose-fail')).getByRole('img', { name: 'Failed' }),
    ).toBeInTheDocument();
  });
});

describe('a code-agent row opens its own conversation (flag on, view provider)', () => {
  function renderWithView(selectedAgentId: string | null, onSelectAgent = vi.fn()) {
    const user = signedInUser();
    function Bar({ selected }: { selected: string | null }) {
      return (
        <CodeAgentViewProvider enabled selectedAgentId={selected} onSelectAgent={onSelectAgent}>
          <AppSidebar
            {...defaultProps({ agents: AGENTS, user, selectedAgentId: selected, onSelectAgent })}
          />
        </CodeAgentViewProvider>
      );
    }
    const result = renderWithProviders(<Bar selected={selectedAgentId} />);
    return {
      ...result,
      onSelectAgent,
      rerenderWith: (id: string | null) => result.rerender(<Bar selected={id} />),
    };
  }

  afterEach(() => window.history.replaceState({}, '', '/'));

  it('marks the open row (aria-current, weight/color), not its owner; the owner row returns without re-selecting', async () => {
    const user = userEvent.setup();
    const { onSelectAgent } = renderWithView('home-run');
    expandBar();
    const row = await openCodeRow('cc-build');
    const owner = screen.getByTestId('rose-agent-row-home-run');
    expect(owner).toHaveAttribute('aria-current', 'true');
    await user.click(row);
    // Owner already selected: nothing re-selects it.
    expect(onSelectAgent).not.toHaveBeenCalled();
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveAttribute('data-selected', 'true');
    expect(row.className).toContain('font-semibold');
    expect(owner).not.toHaveAttribute('aria-current');
    expect(new URL(window.location.href).searchParams.get('code-agent')).toBe('cc-build');

    await user.click(owner);
    expect(onSelectAgent).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="rose-code-agent-row-cc-build"][aria-current]'),
    ).toBeNull();
    expect(owner).toHaveAttribute('aria-current', 'true');
    expect(new URL(window.location.href).searchParams.get('code-agent')).toBeNull();
  });

  it("a sub-agent's code agent selects its owner first; another agent row leaves it", async () => {
    const user = userEvent.setup();
    const { onSelectAgent, rerenderWith } = renderWithView('home-run');
    expandBar();
    await user.click(await openCodeRow('cc-sub'));
    expect(onSelectAgent).toHaveBeenCalledWith('rose-sub');
    rerenderWith('rose-sub');
    expect(screen.getByTestId('rose-code-agent-row-cc-sub')).toHaveAttribute(
      'aria-current',
      'true',
    );

    await user.click(screen.getByTestId('rose-agent-row-home-done'));
    expect(onSelectAgent).toHaveBeenLastCalledWith('home-done');
    rerenderWith('home-done');
    // Crossing sidebar rows can collapse the hovered bar; finished drawers
    // start closed when reopened. Reopen it to inspect the previous row.
    expect(await openCodeRow('cc-sub')).not.toHaveAttribute('aria-current');
  });
});

describe('Code-agent row actions', () => {
  it('keeps the hovered sidebar open while using a coding-agent menu or rename dialog', async () => {
    const user = userEvent.setup();
    renderBar();
    fireEvent.contextMenu(await openCodeRow('cc-fix'));
    fireEvent.mouseLeave(roseBar());
    expect(roseBar()).toHaveAttribute('data-expanded', 'true');
    await user.click(await screen.findByRole('menuitem', { name: 'Rename agent' }));
    fireEvent.mouseLeave(roseBar());
    expect(screen.getByRole('dialog', { name: 'Rename' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Rename' })).toBeNull();
    fireEvent.mouseLeave(roseBar());
    expect(roseBar()).toHaveAttribute('data-expanded', 'false');
  });

  it.each(['cc-fix', 'cc-build', 'cc-sub'])(
    'copies the code task ID for %s, never its owner ID',
    async (id) => {
      const user = userEvent.setup();
      const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
      renderBar();
      const row = await openCodeRow(id);
      fireEvent.contextMenu(row);
      await user.click(await screen.findByRole('menuitem', { name: 'Copy agent ID' }));
      expect(write).toHaveBeenCalledWith(id);
    },
  );

  it('persists a code-agent rename and displays the saved name after remount', async () => {
    const user = userEvent.setup();
    const rows = ROWS.map((row) => ({ ...row }));
    mockCodeAgents(rows);
    const patches: unknown[] = [];
    server.use(
      http.patch(`${API_BASE}/agents/code-agents/cc-fix`, async ({ request }) => {
        const body = (await request.json()) as { title: string };
        patches.push(body);
        rows[0].title = body.title;
        return HttpResponse.json({ code_agent_id: 'cc-fix', title: body.title });
      }),
    );
    const view = renderBar();
    fireEvent.contextMenu(await openCodeRow('cc-fix'));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename agent' }));
    const input = await screen.findByRole('textbox', { name: 'Agent name' });
    expect(input).toHaveValue('Fix flaky test');
    await user.clear(input);
    await user.type(input, '  Fix export tests  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toEqual([{ title: 'Fix export tests' }]));
    expect(await screen.findByTestId('rose-code-agent-row-cc-fix')).toHaveTextContent(
      'Fix export tests',
    );
    view.unmount();
    renderBar();
    expect(await openCodeRow('cc-fix')).toHaveTextContent('Fix export tests');
  });
});
