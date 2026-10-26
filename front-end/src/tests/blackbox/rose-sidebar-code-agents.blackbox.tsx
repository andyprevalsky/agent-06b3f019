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
 * A code-agent row is ONLY its provider icon + title: no done check, failed x,
 * amber needs-input alert or thinking bubble in any state (supersedes ledger
 * row 79). Agent (robot) rows keep their own status glyphs.
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
import type { CodeAgentListItem } from '@/lib/api/tree';

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

vi.mock('@/lib/realtime', async (original) => ({
  ...(await original<typeof import('@/lib/realtime')>()),
  subscribeToBus: vi.fn(async () => ({ state: 'joined' })),
  unsubscribe: vi.fn(),
}));

const API_BASE = 'http://localhost:3001/api';
const RUNNING = { status: 'ACTIVE' as const, temporal_workflow_id: 'wf-1' };
const createdMinutesAgo = (minutes: number) => ({
  created_at: new Date(Date.parse('2026-10-20T12:00:00Z') - minutes * 60_000).toISOString(),
});
const AGENTS = [
  makeAgent({ agent_id: 'home-run', goal: 'Plan Tahoe trip', ...RUNNING, ...createdMinutesAgo(1) }),
  makeAgent({
    agent_id: 'home-done',
    goal: 'Get me socks',
    status: 'COMPLETED',
    ...createdMinutesAgo(2),
  }),
  makeAgent({
    agent_id: 'rose-run',
    goal: 'Rose UI polish',
    ...RUNNING,
    project_id: 'p-rose',
    ...createdMinutesAgo(3),
  }),
  makeAgent({
    agent_id: 'rose-fail',
    goal: 'Fix Hub export retry',
    status: 'FAILED',
    project_id: 'p-rose',
    ...createdMinutesAgo(4),
  }),
  makeAgent({
    agent_id: 'habits-done',
    goal: 'Streak widget',
    status: 'COMPLETED',
    project_id: 'p-habits',
    ...createdMinutesAgo(5),
  }),
  makeAgent({
    agent_id: 'orphan',
    goal: 'Unknown project agent',
    ...RUNNING,
    project_id: 'gone',
    ...createdMinutesAgo(6),
  }),
];

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

function codeAgent(
  overrides: Partial<CodeAgentListItem> & { code_agent_id: string },
): CodeAgentListItem {
  return {
    owner_agent_id: 'home-run',
    root_agent_id: 'home-run',
    provider: 'claude',
    title: 'Write the export retry',
    status: 'ACTIVE',
    created_at: '2026-10-20T11:00:00.000Z',
    ...overrides,
  };
}

function mockCodeAgents(rows: CodeAgentListItem[]) {
  server.use(
    http.get(`${API_BASE}/agents/code-agents`, ({ request }) => {
      const raw = new URL(request.url).searchParams.get('root_ids') ?? '';
      const ids = raw.split(',').filter(Boolean);
      if (ids.length === 0 || ids.length > 50) {
        return HttpResponse.json({ error: 'root_ids must list 1-50 agent ids' }, { status: 400 });
      }
      const roots = new Set(ids);
      return HttpResponse.json({
        code_agents: rows.filter((row) => roots.has(row.root_agent_id)).slice(0, 500),
      });
    }),
  );
}

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

/** The attention row agent-tools writes for a code agent's question (questionService). */
function codeAgentQuestion(taskId: string, answered = false): AttentionRequest {
  return {
    id: `atq_${taskId}`,
    agent_id: 'home-run',
    workflow_id: 'wf-1',
    question: 'Ship the 26px button?',
    metadata: {
      agentTools: { kind: 'question', deliverTo: 'user', routedAgentId: 'home-run' },
      requestingAgent: {
        kind: 'code_agent',
        agent_id: 'home-run',
        label: 'Claude Code',
        provider: 'claude',
        task_id: taskId,
      },
      sandboxTool: { provider: 'claude', taskId },
    },
    created_at: '2026-10-20T11:30:00.000Z',
    updated_at: '2026-10-20T11:30:00.000Z',
    answered,
  };
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

function bulkAgents(count: number, overrides: (i: number) => Partial<Agent> = () => ({})) {
  return Array.from({ length: count }, (_, i) =>
    makeAgent({
      agent_id: `bulk-${i}`,
      goal: `Bulk ${i}`,
      status: 'COMPLETED',
      ...createdMinutesAgo(i + 1),
      ...overrides(i),
    }),
  );
}

const ROWS = [
  codeAgent({
    code_agent_id: 'cc-fix',
    provider: 'codex',
    status: 'ERROR',
    title: 'Fix flaky test',
  }),
  codeAgent({
    code_agent_id: 'cc-build',
    provider: 'claude',
    title: 'Build the widget',
    created_at: '2026-10-20T10:00:00.000Z',
  }),
  // Owned by a sub-agent of rose-run: listed under its root row; provider null = legacy → Claude.
  codeAgent({
    code_agent_id: 'cc-sub',
    owner_agent_id: 'rose-sub',
    root_agent_id: 'rose-run',
    provider: null,
    status: 'COMPLETED',
    title: 'Refactor nav',
  }),
];

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
    const row = await screen.findByTestId(`rose-agent-row-${agentId}`);
    const wrapper = row.closest('[data-agent-depth]') as HTMLElement;
    const toggle = await within(wrapper).findByRole('button', { name: /^Expand|^Collapse/ });
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  }
  return screen.findByTestId(`rose-code-agent-row-${id}`);
}

describe('Rose left bar code agents (flag on)', () => {
  it("one batched request lists each tree's code agents under its root row, oldest first", async () => {
    renderBar();
    expandBar();
    await openCodeRow('cc-sub');
    await openCodeRow('cc-fix');
    expect(barRowOrder()).toEqual([
      'agent:home-run',
      'code-agent:cc-build',
      'code-agent:cc-fix',
      'agent:orphan',
      'agent:home-done',
      'project:p-rose',
      'agent:rose-run',
      'agent:rose-sub',
      'code-agent:cc-sub',
      'agent:rose-fail',
      'project:p-habits',
      'agent:habits-done',
    ]);
    expect(codeAgentRequests()).toHaveLength(1);
    expect(new Set(codeAgentRequests()[0])).toEqual(new Set(AGENTS.map((a) => a.agent_id)));
    expect(new Set(treeRequests().map((r) => new URL(r.url).searchParams.get('busId')))).toEqual(
      ids(AGENTS),
    );
    // Initially ungrouped roots can remount once when their projects arrive.
    expect(treeRequests().length).toBeLessThanOrEqual(AGENTS.length * 2);
    // One level under the parent: Home agent rows sit at 22px, project agent rows at 34px.
    expect(screen.getByTestId('rose-code-agent-row-cc-build')).toHaveStyle({ paddingLeft: '38px' });
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

describe('code-agent rows carry no status glyph (flag on)', () => {
  /** Every image in a row (the provider icon is the only one allowed). */
  const rowImages = (id: string) =>
    within(screen.getByTestId(`rose-code-agent-row-${id}`))
      .queryAllByRole('img')
      .map((img) => img.getAttribute('aria-label') ?? img.getAttribute('alt'));

  function expectIconOnly(id: string, provider: 'Claude Code' | 'Codex') {
    const row = screen.getByTestId(`rose-code-agent-row-${id}`);
    expect(rowImages(id)).toEqual([provider]);
    // No check, x, alert, spinner or thinking.svg bubble.
    expect(row.querySelectorAll('svg')).toHaveLength(0);
    expect(row.querySelectorAll('img')).toHaveLength(1);
    expect(within(row).queryByTestId('rose-code-agent-thinking')).toBeNull();
  }

  it.each([
    ['light', false],
    ['dark', true],
  ])('running, failed and completed rows show only the provider icon (%s)', async (_, dark) => {
    renderBar({}, { dark });
    await openCodeRow('cc-sub');
    await openCodeRow('cc-fix');
    expandBar();
    expectIconOnly('cc-build', 'Claude Code');
    expectIconOnly('cc-fix', 'Codex');
    expectIconOnly('cc-sub', 'Claude Code');
  });

  it('a running code agent waiting on an unanswered question still shows no glyph', async () => {
    renderBar({}, { attention: [codeAgentQuestion('cc-build')] });
    await openCodeRow('cc-build');
    expectIconOnly('cc-build', 'Claude Code');
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
    expect(screen.getByTestId('rose-code-agent-row-cc-sub')).not.toHaveAttribute('aria-current');
  });
});
