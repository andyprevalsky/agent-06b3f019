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

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
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

function renderBar(overrides: Parameters<typeof defaultProps>[0] = {}) {
  return renderWithProviders(
    <AppSidebar {...defaultProps({ agents: AGENTS, user: signedInUser(), ...overrides })} />,
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
    mockProjectsApi([makeProject(), makeProject({ id: 'p-habits', name: 'Habits', envFiles: [] })]);
  });
  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
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
    expect(create.className).toContain('bg-gray-950');
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
    // Done = muted check, green only in dark.
    const check = row('habits-done').querySelector('svg.lucide-check')!;
    expect(check.getAttribute('class')).toContain('text-gray-400');
    expect(check.getAttribute('class')).toContain('dark:text-[#22c55e]');
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
    expect(bar.className).toContain('bg-white');
    expect(bar.className).toContain('dark:bg-[#262624]');
    expect(bar.className).toContain('dark:border-white/[0.09]');
    expect(within(bar).getByRole('button', { name: 'Home' }).className).toContain(
      'dark:text-[#ecece8]',
    );
    expect(within(bar).getByRole('button', { name: 'Archived' }).className).toContain(
      'dark:text-[#a3a39d]',
    );
    const bot = screen
      .getByTestId('rose-agent-row-home-run')
      .querySelector('[data-sidebar-agent-icon]')!;
    expect(bot.getAttribute('class')).toContain('dark:text-[#a3a39d]');
  });
});
