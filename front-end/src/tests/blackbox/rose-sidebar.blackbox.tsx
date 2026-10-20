/**
 * Blackbox tests for the Rose Desktop left bar (AppSidebar with the flag on):
 * order, project grouping, collapsed dividers, hover-expand, run-state glyphs,
 * bottom rows (Feedback / Biz health / Archived / account), account glyph and
 * Settings drawer. Flag off keeps the stock sidebar (app-sidebar suites).
 * Projects, project settings and the agent right-click menu live in
 * rose-sidebar-projects.blackbox.tsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';

import { MAX_CODE_AGENT_TREES } from '@/features/terminal-component-group/components/rose-sidebar/useRoseCodeAgents';
import type { CodeAgentNode } from '@/lib/api/tree';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';
import {
  anonymousUser,
  collapseBar,
  expandBar,
  makeProject,
  mockProjectsApi,
  roseBar,
  signedInUser,
} from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const RUNNING = { status: 'ACTIVE' as const, temporal_workflow_id: 'wf-1' };
// Fixed creation times: within a run state, sortAgents orders newest first, so
// Date.now()-based defaults would make same-state order depend on timing.
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

function renderBar(overrides: Parameters<typeof defaultProps>[0] = {}, { dark = false } = {}) {
  const user = signedInUser();
  // Dark = the signed-in user's stored Rose theme choice (features/rose-theme).
  if (dark) localStorage.setItem(`rose-theme:${user.id}`, 'dark');
  return renderWithProviders(
    <AppSidebar {...defaultProps({ agents: AGENTS, user, ...overrides })} />,
    { roseThemeUserId: user.id },
  );
}

function rowOrder(): string[] {
  const groups = screen.getByTestId('rose-agent-groups');
  return [
    ...groups.querySelectorAll<HTMLElement>(
      '[data-testid^="rose-agent-row-"], [data-testid^="rose-project-row-"]',
    ),
  ].map((el) => el.dataset.testid!.replace(/^rose-(agent|project)-row-/, '$1:'));
}

describe('Rose left bar (flag on)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    mockProjectsApi([makeProject(), makeProject({ id: 'p-habits', name: 'Habits' })]);
  });
  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('below md the bar does not mount (the mobile drawer lists agents)', () => {
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      renderBar();
      expect(screen.queryByTestId('rose-sidebar')).toBeNull();
      expect(screen.queryByText('Plan Tahoe trip')).toBeNull();
    } finally {
      window.innerWidth = width;
    }
  });

  it('flag off renders the stock sidebar, flag on the Rose bar', () => {
    const { unmount } = renderWithProviders(<AppSidebar {...defaultProps()} />, {
      roseDesktop: false,
    });
    expect(screen.queryByTestId('rose-sidebar')).toBeNull();
    expect(screen.getByLabelText('Resize sidebar')).toBeInTheDocument();
    unmount();
    renderBar();
    expect(roseBar()).toBeInTheDocument();
    // No drag: the Rose bar has no resize handle (row 21).
    expect(screen.queryByLabelText('Resize sidebar')).toBeNull();
  });

  it('orders Home, New Super Agent (black), Search, then Home agents and each project with its agents', async () => {
    renderBar();
    const bar = roseBar();
    const top = within(bar).getAllByRole('button').slice(0, 2);
    expect(top.map((b) => b.getAttribute('aria-label'))).toEqual(['Home', 'New Super Agent']);
    const create = within(bar).getByRole('button', { name: 'New Super Agent' });
    // Light: raw black with white label/plus (unchanged). Dark inverts it like
    // the mock (.nb: #f2f2ef fill, #1f1f1d label/plus) instead of black on the dark bar.
    expect(create).toHaveClass('bg-gray-950', 'text-white', 'hover:bg-gray-800');
    expect(create).toHaveClass(
      'dark:bg-[#f2f2ef]',
      'dark:text-[#1f1f1d]',
      'dark:hover:bg-[#e4e4df]',
    );
    expect(create.className).not.toMatch(/(^|\s)(bg|text)-\[#(f2f2ef|1f1f1d)\]/);
    expect(create).not.toHaveTextContent('New Super Agent');
    expect(within(bar).getByRole('searchbox', { name: 'Search agents' })).toBeInTheDocument();

    expandBar();
    expect(create).toHaveTextContent('New Super Agent');
    await screen.findByTestId('rose-project-row-p-rose');
    expect(rowOrder()).toEqual([
      // Home: running first (sortAgents), an unknown project_id falls back to Home.
      'agent:home-run',
      'agent:orphan',
      'agent:home-done',
      'project:p-rose',
      'agent:rose-run',
      'agent:rose-fail',
      'project:p-habits',
      'agent:habits-done',
    ]);
    // Project agents sit indented while expanded; Home agents do not.
    expect(screen.getByTestId('rose-agent-row-rose-run').className).toContain('pl-[34px]');
    expect(screen.getByTestId('rose-agent-row-home-run').className).not.toContain('pl-[34px]');
    // Project rows carry + (new agent here) and ⚙ (settings).
    const project = screen.getByTestId('rose-project-row-p-rose');
    expect(within(project).getByRole('button', { name: 'New agent in Rose' })).toBeInTheDocument();
    expect(
      within(project).getByRole('button', { name: 'Rose project settings' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ New project' })).toBeInTheDocument();
  });

  it('Home returns to the root project and New Super Agent starts one (same handler as stock)', async () => {
    const user = userEvent.setup();
    const onCreateAgent = vi.fn();
    renderBar({ onCreateAgent });
    await user.click(within(roseBar()).getByRole('button', { name: 'Home' }));
    expect(onCreateAgent).toHaveBeenCalledTimes(1);
    await user.click(within(roseBar()).getByRole('button', { name: 'New Super Agent' }));
    expect(onCreateAgent).toHaveBeenCalledTimes(2);
  });

  it('hover expands to titles; collapsed hides project rows behind 18x3 line-pill dividers', async () => {
    renderBar();
    const bar = roseBar();
    expect(bar.style.width).toBe('64px');
    expect(bar).toHaveAttribute('data-expanded', 'false');
    await waitFor(() => expect(screen.getAllByTestId('rose-group-divider')).toHaveLength(2));
    expect(screen.queryByTestId('rose-project-row-p-rose')).toBeNull();
    expect(screen.queryByRole('button', { name: '+ New project' })).toBeNull();
    const pill = screen.getAllByTestId('rose-group-divider')[0].querySelector('i')!;
    expect(pill.className).toContain('h-[3px]');
    expect(pill.className).toContain('w-[18px]');
    expect(pill.className).toContain('dark:bg-white/[0.14]');

    expandBar();
    expect(bar.style.width).toBe('236px');
    expect(bar).toHaveAttribute('data-expanded', 'true');
    expect(screen.queryByTestId('rose-group-divider')).toBeNull();
    expect(screen.getByText('Plan Tahoe trip').className).toContain('opacity-100');

    collapseBar();
    expect(bar.style.width).toBe('64px');
  });

  it('collapsed icons use the gray Bot glyph plus only the supported status glyphs', async () => {
    renderBar({ attentionAgentIds: new Set(['home-done']) });
    const row = (id: string) => screen.getByTestId(`rose-agent-row-${id}`);
    await waitFor(() => expect(row('home-run')).toBeInTheDocument());
    // Running = bare Bot (no status glyph).
    expect(row('home-run').querySelector('[data-sidebar-agent-icon]')).not.toBeNull();
    expect(within(row('home-run')).queryByRole('img')).toBeNull();
    // Needs your input = amber alert.
    expect(row('home-done').querySelector('.text-amber-500')).not.toBeNull();
    // Done = muted check; light keeps the stock gray check (green only in
    // dark — asserted on the code-agent rows below).
    const check = row('habits-done').querySelector('svg.lucide-check')!;
    expect(check.getAttribute('class')).toContain('text-gray-400');
    expect(check.getAttribute('class')).not.toContain('22c55e');
    // Failed = muted red x.
    expect(
      within(row('rose-fail'))
        .getByRole('img', { name: 'Failed' })
        .querySelector('.text-red-400\\/80'),
    ).not.toBeNull();
    // No custom colored dots.
    expect(
      roseBar().querySelector('.rounded-full.bg-green-500, .rounded-full.bg-\\[\\#22c55e\\]'),
    ).toBeNull();
  });

  it('search filters agents and drops empty project groups', async () => {
    const user = userEvent.setup();
    renderBar();
    expandBar();
    await screen.findByTestId('rose-project-row-p-habits');
    await user.type(screen.getByRole('searchbox', { name: 'Search agents' }), 'streak');
    await waitFor(() => expect(rowOrder()).toEqual(['project:p-habits', 'agent:habits-done']));
  });

  it('bottom: Feedback (all users), Biz health (admins only), Archived, then the account row; no Settings button', async () => {
    const { unmount } = renderBar();
    const bottom = () =>
      within(roseBar())
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'))
        .slice(-3);
    expect(bottom()).toEqual(['Feedback', 'Archived', 'Andy Prevalsky']);
    const bar = roseBar();
    expect(
      within(bar).getByRole('button', { name: 'Feedback' }).querySelector('svg.lucide-megaphone'),
    ).not.toBeNull();
    expect(within(bar).queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(within(bar).queryByRole('button', { name: 'Biz health' })).toBeNull();
    unmount();

    renderBar({ showAdminHealth: true });
    expect(bottom()).toEqual(['Biz health', 'Archived', 'Andy Prevalsky']);
  });

  it('Biz health opens the admin health page in the right drawer; clicking again closes it', async () => {
    const user = userEvent.setup();
    renderBar({ showAdminHealth: true });
    const biz = within(roseBar()).getByRole('button', { name: 'Biz health' });
    await user.click(biz);
    const panel = screen.getByTestId('rose-app-panel');
    expect(panel).toHaveAttribute('data-state', 'open');
    expect(within(panel).getByText('Biz health')).toBeInTheDocument();
    expect(within(panel).getByTestId('rose-app-panel-health')).toBeInTheDocument();
    expect(biz).toHaveAttribute('aria-pressed', 'true');
    await user.click(biz);
    expect(panel).toHaveAttribute('data-state', 'closed');
  });

  it('Feedback opens in the right drawer for every user', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(within(roseBar()).getByRole('button', { name: 'Feedback' }));
    expect(screen.getByTestId('rose-app-panel-feedback')).toBeInTheDocument();
  });

  it('account row: cursive Pinyon Script initial (no circle) when signed in; opens Settings with the existing tabs', async () => {
    const user = userEvent.setup();
    renderBar();
    const account = within(roseBar()).getByRole('button', { name: 'Andy Prevalsky' });
    const initial = within(account).getByTestId('rose-account-initial');
    expect(initial).toHaveTextContent('A');
    expect(initial.style.fontFamily).toContain('Pinyon Script');
    expect(initial.style.fontSize).toBe('27px');
    expect(initial.className).not.toMatch(/rounded|bg-|border|ring/);
    expect(initial.querySelector('style')?.textContent).toMatch(
      /@font-face\{font-family:'Pinyon Script'.*woff2/,
    );

    await user.click(account);
    const panel = screen.getByTestId('rose-app-panel');
    expect(panel).toHaveAttribute('data-state', 'open');
    expect(panel.style.top).toBe('0px');
    expect(panel.style.right).toBe('0px');
    const body = within(panel).getByTestId('rose-app-panel-settings');
    const tabs = await within(body).findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Customization',
      'Personal Info',
      'Billing',
      'API Keys',
    ]);
    // Embedded: the drawer header is the title; no second "Settings" card.
    expect(within(body).queryByRole('heading', { level: 1 })).toBeNull();
    await user.click(within(body).getByRole('tab', { name: 'Billing' }));
    const plan = await within(body).findByText('Current Plan');
    const payments = within(body).getByTestId('rose-billing-payments');
    expect(plan.compareDocumentPosition(payments) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Clicking the account row again closes it.
    await user.click(account);
    expect(panel).toHaveAttribute('data-state', 'closed');
  });

  it('account row Settings hosts the admin account switcher (admins only; FE-13)', async () => {
    const user = userEvent.setup();
    // Andy: an admin on the Rose Desktop flag. His switcher moved off the top-right
    // corner (4 bare app icons only) into Settings, above the existing tabs.
    localStorage.setItem(
      'rose-session',
      JSON.stringify({
        access_token: 'andy-token',
        refresh_token: 'andy-refresh',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer',
        user: { id: '1f85ff25-6e29-4c1b-8739-f917bd101a30', phone: '+19729777432' },
      }),
    );
    renderBar();
    await user.click(within(roseBar()).getByRole('button', { name: 'Andy Prevalsky' }));
    const body = screen.getByTestId('rose-app-panel-settings');
    const switcher = await within(body).findByTestId('admin-account-switcher');
    expect(switcher).toHaveAttribute('data-variant', 'inline');
    expect(within(switcher).getByTestId('admin-account-pill')).toHaveTextContent('+19729777432');
    const tabs = await within(body).findAllByRole('tab');
    expect(
      switcher.compareDocumentPosition(tabs[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Fully functional in place: the panel opens in flow inside Settings.
    await user.click(within(switcher).getByRole('button', { name: 'Switch account' }));
    const dialog = within(switcher).getByRole('dialog', { name: 'Account switcher' });
    expect(dialog.className).not.toMatch(/(^|\s)(absolute|fixed)(\s|$)/);
    expect(within(dialog).getByRole('button', { name: /Tamy/ })).toBeVisible();
    expect(within(dialog).getByRole('searchbox', { name: 'Search accounts' })).toBeVisible();
  });

  it('account row Settings shows no switcher for a non-admin', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(within(roseBar()).getByRole('button', { name: 'Andy Prevalsky' }));
    const body = screen.getByTestId('rose-app-panel-settings');
    await within(body).findAllByRole('tab');
    expect(within(body).queryByTestId('admin-account-switcher')).toBeNull();
  });

  it('account row: anonymous = member icon (opens Settings); no session = Sign in', async () => {
    const user = userEvent.setup();
    const { unmount } = renderBar({ user: anonymousUser() });
    const guest = within(roseBar()).getByRole('button', { name: 'Guest' });
    expect(within(guest).getByTestId('rose-account-member-icon')).toBeInTheDocument();
    expect(within(guest).queryByTestId('rose-account-initial')).toBeNull();
    await user.click(guest);
    expect(screen.getByTestId('rose-app-panel')).toHaveAttribute('data-state', 'open');
    unmount();

    const props = defaultProps({ agents: AGENTS, user: null });
    renderWithProviders(<AppSidebar {...props} />);
    await user.click(within(roseBar()).getByRole('button', { name: 'Sign in' }));
    expect(props.onLoginClick).toHaveBeenCalledTimes(1);
  });

  it('every bar surface carries dark tokens (light unchanged)', () => {
    renderBar();
    const bar = roseBar();
    // Always solid, so it reads as opaque over a per-user background image.
    expect(bar).toHaveAttribute('data-surface', 'opaque');
    expect(bar.className).toContain('bg-white');
    expect(bar.className).toContain('dark:bg-[#262624]');
    expect(bar.className).toContain('dark:border-white/[0.09]');
    expect(within(bar).getByRole('button', { name: 'Home' }).className).toContain(
      'dark:text-[#ecece8]',
    );
    expect(within(bar).getByRole('button', { name: 'Archived' }).className).toContain(
      'dark:text-[#a3a39d]',
    );
    expect(within(bar).getByRole('button', { name: 'New Super Agent' }).className).toContain(
      'dark:bg-[#f2f2ef]',
    );
    const bot = screen
      .getByTestId('rose-agent-row-home-run')
      .querySelector('[data-sidebar-agent-icon]')!;
    expect(bot.getAttribute('class')).toContain('dark:text-[#a3a39d]');
  });
});

// ─── Code agents (GET /api/agents/tree → code_agents) ───────────────────────

const API_BASE = 'http://localhost:3001/api';

function codeAgent(overrides: Partial<CodeAgentNode> & { code_agent_id: string }): CodeAgentNode {
  return {
    owner_agent_id: 'home-run',
    goal: 'Write the export retry',
    status: 'ACTIVE',
    created_at: '2026-10-20T11:00:00.000Z',
    ...overrides,
  };
}

/** Trees keyed by busId (= root agent id); every other root has no code agents. */
function mockCodeAgentTrees(trees: Record<string, CodeAgentNode[]>) {
  server.use(
    http.get(`${API_BASE}/agents/tree`, ({ request }) => {
      const busId = new URL(request.url).searchParams.get('busId') ?? '';
      return HttpResponse.json({ agents: [], code_agents: trees[busId] ?? [] });
    }),
  );
}

function treeRequests(): string[] {
  return capturedRequests
    .filter((r) => r.method === 'GET' && new URL(r.url).pathname === '/api/agents/tree')
    .map((r) => new URL(r.url).searchParams.get('busId') ?? '');
}

function barRowOrder(): string[] {
  const groups = screen.getByTestId('rose-agent-groups');
  return [
    ...groups.querySelectorAll<HTMLElement>(
      '[data-testid^="rose-agent-row-"], [data-testid^="rose-code-agent-row-"], [data-testid^="rose-project-row-"]',
    ),
  ].map((el) => el.dataset.testid!.replace(/^rose-(agent|code-agent|project)-row-/, '$1:'));
}

describe('Rose left bar code agents (flag on)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
    mockProjectsApi([makeProject(), makeProject({ id: 'p-habits', name: 'Habits' })]);
    mockCodeAgentTrees({
      'home-run': [
        codeAgent({
          code_agent_id: 'cc-fix',
          provider: 'codex',
          status: 'ERROR',
          goal: 'Fix flaky test',
        }),
        codeAgent({
          code_agent_id: 'cc-build',
          provider: 'claude',
          goal: 'Build the widget',
          created_at: '2026-10-20T10:00:00.000Z',
        }),
      ],
      // Owned by a sub-agent of rose-run: listed under its root row; no provider → Claude.
      'rose-run': [
        codeAgent({
          code_agent_id: 'cc-sub',
          owner_agent_id: 'rose-sub',
          status: 'COMPLETED',
          goal: 'Refactor nav',
        }),
      ],
    });
  });
  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it("lists each tree's code agents under its agent row, indented one level, oldest first", async () => {
    renderBar();
    expandBar();
    await screen.findByTestId('rose-code-agent-row-cc-sub');
    await screen.findByTestId('rose-code-agent-row-cc-fix');
    expect(barRowOrder()).toEqual([
      'agent:home-run',
      'code-agent:cc-build',
      'code-agent:cc-fix',
      'agent:orphan',
      'agent:home-done',
      'project:p-rose',
      'agent:rose-run',
      'code-agent:cc-sub',
      'agent:rose-fail',
      'project:p-habits',
      'agent:habits-done',
    ]);
    // One level under the parent: Home agent rows sit at 22px, project agent rows at 34px.
    expect(screen.getByTestId('rose-code-agent-row-cc-build').className).toContain('pl-[34px]');
    expect(screen.getByTestId('rose-code-agent-row-cc-sub').className).toContain('pl-[46px]');
    expect(screen.getByTestId('rose-code-agent-row-cc-build')).toHaveTextContent(
      'Build the widget',
    );
  });

  it('uses the Claude / Codex icon instead of the Bot glyph, with only the supported status glyphs', async () => {
    renderBar({}, { dark: true });
    const row = (id: string) => screen.getByTestId(`rose-code-agent-row-${id}`);
    await screen.findByTestId('rose-code-agent-row-cc-sub');
    await screen.findByTestId('rose-code-agent-row-cc-fix');
    for (const id of ['cc-build', 'cc-fix', 'cc-sub']) {
      expect(row(id).querySelector('[data-sidebar-agent-icon], svg.lucide-bot')).toBeNull();
    }
    // Running Claude session = bare provider icon.
    expect(within(row('cc-build')).getByRole('img', { name: 'Claude Code' })).toBeInTheDocument();
    expect(
      within(row('cc-build')).queryByRole('img', { name: /Working|Completed|Failed/ }),
    ).toBeNull();
    // Failed Codex session = Codex icon + muted red x.
    expect(within(row('cc-fix')).getByRole('img', { name: 'Codex' })).toBeInTheDocument();
    const failed = within(row('cc-fix')).getByRole('img', { name: 'Failed' });
    expect(failed.querySelector('.text-red-400\\/80')).not.toBeNull();
    // Missing provider defaults to Claude; done = muted check, green only in dark.
    expect(row('cc-sub')).toHaveAttribute('data-provider', 'claude');
    const check = within(row('cc-sub'))
      .getByRole('img', { name: 'Completed' })
      .querySelector('svg.lucide-check')!;
    expect(check.getAttribute('class')).toContain('text-gray-400');
    expect(check.getAttribute('class')).toContain('dark:text-[#22c55e]');
    expect(row('cc-sub').className).toContain('dark:text-[#a3a39d]');
  });

  it("collapsed: code agents stay in their parent's group with no divider between them", async () => {
    renderBar();
    const build = await screen.findByTestId('rose-code-agent-row-cc-build');
    const sub = await screen.findByTestId('rose-code-agent-row-cc-sub');
    expect(roseBar()).toHaveAttribute('data-expanded', 'false');
    expect(build.className).toContain('px-[22px]');
    expect(screen.getByTestId('rose-group-home')).toContainElement(build);
    expect(screen.getByTestId('rose-group-p-rose')).toContainElement(sub);
    expect(screen.getAllByTestId('rose-group-divider')).toHaveLength(2);
    expect(
      screen.getByTestId('rose-group-p-rose').querySelector('[data-testid="rose-group-divider"]'),
    ).toBeNull();
  });

  it('clicking a code agent opens its owner conversation; a provided handler replaces that', async () => {
    const user = userEvent.setup();
    const onSelectAgent = vi.fn();
    const { unmount } = renderBar({ onSelectAgent });
    await user.click(await screen.findByTestId('rose-code-agent-row-cc-sub'));
    expect(onSelectAgent).toHaveBeenCalledWith('rose-sub');
    unmount();

    const onOpenCodeAgent = vi.fn();
    renderBar({ roseActions: { onOpenCodeAgent } });
    await user.click(await screen.findByTestId('rose-code-agent-row-cc-fix'));
    expect(onOpenCodeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        code_agent_id: 'cc-fix',
        owner_agent_id: 'home-run',
        provider: 'codex',
      }),
    );
  });

  it('reads a bounded number of trees: the selected row plus the first rows', async () => {
    const many = Array.from({ length: MAX_CODE_AGENT_TREES + 5 }, (_, i) =>
      makeAgent({
        agent_id: `bulk-${i}`,
        goal: `Bulk ${i}`,
        status: 'COMPLETED',
        ...createdMinutesAgo(i + 1),
      }),
    );
    const last = `bulk-${MAX_CODE_AGENT_TREES + 4}`;
    renderWithProviders(
      <AppSidebar
        {...defaultProps({ agents: many, user: signedInUser(), selectedAgentId: last })}
      />,
    );
    await waitFor(() => expect(treeRequests()).toHaveLength(MAX_CODE_AGENT_TREES));
    expect(treeRequests()).toContain(last);
    expect(treeRequests()).not.toContain(`bulk-${MAX_CODE_AGENT_TREES + 3}`);
  });

  it('flag off: the stock sidebar reads no trees and shows no code agents', async () => {
    renderWithProviders(
      <AppSidebar {...defaultProps({ agents: AGENTS, user: signedInUser() })} />,
      {
        roseDesktop: false,
      },
    );
    await waitFor(() => expect(screen.getByLabelText('Resize sidebar')).toBeInTheDocument());
    expect(screen.queryByTestId('rose-code-agent-row-cc-build')).toBeNull();
    expect(treeRequests()).toHaveLength(0);
  });
});
