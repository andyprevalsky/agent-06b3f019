/**
 * Blackbox tests for the Rose Desktop left bar (AppSidebar with the flag on):
 * order (Back | Search, projects, Home project last), group dividers, the
 * collapsed icon/agents/pill layout, the pending new-agent project ring,
 * hover-expand, run-state glyphs,
 * bottom rows (Feedback / Biz health / Archived / account), account glyph and
 * Settings drawer. Flag off keeps the stock sidebar (app-sidebar suites).
 * The "View X old agents" row lives in rose-sidebar-old-agents.blackbox.tsx.
 * Projects, project settings and the agent right-click menu live in
 * rose-sidebar-projects.blackbox.tsx; code-agent rows in
 * rose-sidebar-code-agents.blackbox.tsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from '@supabase/supabase-js';
import { http, HttpResponse } from 'msw';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import * as adminHealthPrewarm from '@/pages/adminHealthPrewarm';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';
import {
  anonymousUser,
  createAgentButton,
  collapseBar,
  expandBar,
  makeProject,
  mockProjectsApi,
  resolvedLeft,
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

const ADMIN_HEALTH_URL = 'http://localhost:3001/api/admin-health';

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
      '[data-testid^="rose-agent-row-"], [data-testid^="rose-project-row-"], [data-testid="rose-home-project-row"], [data-testid="rose-group-divider"]',
    ),
  ].map((el) =>
    el.dataset.testid === 'rose-home-project-row'
      ? 'project:home'
      : el.dataset.testid === 'rose-group-divider'
        ? '──'
        : el.dataset.testid!.replace(/^rose-(agent|project)-row-/, '$1:'),
  );
}

describe('Rose left bar (flag on)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    mockProjectsApi([makeProject(), makeProject({ id: 'p-habits', name: 'Habits' })]);
    // Admin bars (showAdminHealth) prewarm Biz health on mount.
    server.use(
      http.get(ADMIN_HEALTH_URL, () =>
        HttpResponse.json({ error: 'admin health not mocked' }, { status: 503 }),
      ),
    );
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
    // The Rose bar's own right-edge handle (drag to widen + pin; rose-sidebar-resize).
    expect(within(roseBar()).getByLabelText('Resize sidebar')).toHaveAttribute(
      'data-testid',
      'rose-sidebar-resize-handle',
    );
  });

  it('orders Back | Search, then the created projects with their agents, then the Home project last, divided', async () => {
    renderBar();
    const bar = roseBar();
    // Collapsed: the top row is just Search (Back appears once expanded); the
    // old Home row and black New Super Agent button are gone (Andy, 2026-10-28).
    expect(within(bar).queryByRole('button', { name: 'New Super Agent' })).toBeNull();
    expect(within(bar).queryByRole('button', { name: 'Home' })).toBeNull();
    expect(within(bar).queryByRole('button', { name: 'Back' })).toBeNull();
    const top = screen.getByTestId('rose-sidebar-top-row');
    expect(within(top).getByRole('searchbox', { name: 'Search agents' })).toBeInTheDocument();

    expandBar();
    const topControls = [...top.querySelectorAll('button, input')];
    expect(topControls.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Back',
      'Search agents',
    ]);
    // The top row precedes every group.
    const groups = screen.getByTestId('rose-agent-groups');
    expect(top.compareDocumentPosition(groups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await screen.findByTestId('rose-project-row-p-rose');
    expect(rowOrder()).toEqual([
      // Created projects on top (Rose first), a thin divider between groups,
      // then the Home project last: running first (sortAgents), an unknown
      // project_id falls back to Home.
      'project:p-rose',
      'agent:rose-run',
      'agent:rose-fail',
      '──',
      'project:p-habits',
      'agent:habits-done',
      '──',
      'project:home',
      'agent:home-run',
      'agent:orphan',
      'agent:home-done',
    ]);
    // Expanded dividers are thin full-width lines.
    const line = screen.getAllByTestId('rose-group-divider')[0].querySelector('i')!;
    expect(line).toHaveClass('h-px', 'w-full', 'dark:bg-white/[0.07]');
    // Agents sit indented under their project, Home included.
    expect(screen.getByTestId('rose-agent-row-rose-run').className).toContain('pl-[34px]');
    expect(screen.getByTestId('rose-agent-row-home-run').className).toContain('pl-[34px]');
    // Project rows carry + (new agent here) and ⚙ (settings); Home carries +.
    const project = screen.getByTestId('rose-project-row-p-rose');
    expect(within(project).getByRole('button', { name: 'Create Super Agent' })).toBeInTheDocument();
    expect(
      within(project).getByRole('button', { name: 'Rose folder settings' }),
    ).toBeInTheDocument();
    const home = screen.getByTestId('rose-home-project-row');
    expect(home).toHaveTextContent('Home');
    expect(within(home).getByRole('button', { name: 'Create Super Agent' })).toBeInTheDocument();
    // "+ New folder" is the first row of the list: right under Back | Search,
    // above the first project (Andy: "new project above rose").
    const newProject = screen.getByRole('button', { name: '+ New folder' });
    expect(groups.firstElementChild).toBe(newProject);
    expect(
      newProject.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('Back collapses the bar; the Home project + starts a Home agent (same handler as stock)', async () => {
    const user = userEvent.setup();
    const onCreateAgent = vi.fn();
    renderBar({ onCreateAgent });
    expandBar();
    expect(roseBar()).not.toHaveTextContent(/root project/i);
    await user.click(within(roseBar()).getByRole('button', { name: 'Create Super Agent' }));
    expect(onCreateAgent).toHaveBeenCalledTimes(1);
    await user.click(within(roseBar()).getByRole('button', { name: 'Back' }));
    expect(roseBar()).toHaveAttribute('data-expanded', 'false');
  });

  it.each(['p-rose', 'home'])(
    'hovering the %s "+" shows the tooltip "Create Super Agent" (its accessible name too)',
    async (group) => {
      const user = userEvent.setup();
      renderBar();
      expandBar();
      await screen.findByTestId('rose-project-row-p-rose');
      const plus = createAgentButton(group);
      expect(plus).toHaveAttribute('aria-label', 'Create Super Agent');
      await user.hover(plus);
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Create Super Agent');
    },
  );

  it('collapsed: each project icon, then its agents, then a line pill; the Home project last', async () => {
    renderBar();
    const bar = roseBar();
    expect(bar.style.width).toBe('64px');
    expect(bar).toHaveAttribute('data-expanded', 'false');
    await screen.findByTestId('rose-project-row-p-rose');
    expect(rowOrder()).toEqual([
      'project:p-rose',
      'agent:rose-run',
      'agent:rose-fail',
      '──',
      'project:p-habits',
      'agent:habits-done',
      '──',
      'project:home',
      'agent:home-run',
      'agent:orphan',
      'agent:home-done',
    ]);
    // Icons only: names faded, no + / ⚙ buttons. New folder keeps its icon in
    // the same top slot (label faded), so expanding never shifts the rows.
    const project = screen.getByTestId('rose-project-row-p-rose');
    expect(within(project).getByText('Rose').className).toContain('opacity-0');
    expect(within(project).getByRole('button', { name: 'Collapse Rose folder' })).toBeVisible();
    expect(within(project).getAllByRole('button')).toHaveLength(1);
    expect(
      within(screen.getByTestId('rose-home-project-row')).getByRole('button', {
        name: 'Collapse Home',
      }),
    ).toBeVisible();
    const newProject = screen.getByRole('button', { name: '+ New folder' });
    expect(screen.getByTestId('rose-agent-groups').firstElementChild).toBe(newProject);
    expect(within(newProject).getByText('New folder').className).toContain('opacity-0');
    const pill = screen.getAllByTestId('rose-group-divider')[0].querySelector('i')!;
    expect(pill.className).toContain('h-[3px]');
    expect(pill.className).toContain('w-[18px]');
    // Subtle dark divider (separators: white .07).
    expect(pill.className).toContain('dark:bg-white/[0.07]');

    expandBar();
    expect(bar.style.width).toBe('236px');
    expect(bar).toHaveAttribute('data-expanded', 'true');
    expect(screen.getAllByTestId('rose-group-divider')).toHaveLength(2);
    expect(screen.getByText('Plan Tahoe trip').className).toContain('opacity-100');

    collapseBar();
    expect(bar.style.width).toBe('64px');
  });

  it('+ selects the next project without highlighting its icon in either sidebar width', async () => {
    const user = userEvent.setup();
    const onCreateAgentInProject = vi.fn();
    const user0 = signedInUser();
    const props = (selectedAgentId: string | null) =>
      defaultProps({
        agents: AGENTS,
        user: user0,
        selectedAgentId,
        roseActions: { onCreateAgentInProject },
      });
    const { rerender } = renderWithProviders(<AppSidebar {...props('home-run')} />);
    expandBar();
    await screen.findByTestId('rose-project-row-p-rose');
    expect(screen.queryByTestId('pending-project-frame')).toBeNull();

    await user.click(createAgentButton('p-rose'));
    expect(onCreateAgentInProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-rose' }));
    // The terminal clears the selection for the new agent's composer.
    rerender(<AppSidebar {...props(null)} />);
    const row = screen.getByTestId('rose-project-row-p-rose');
    expect(row).toHaveAttribute('data-pending', 'true');
    expect(within(row).queryByTestId('pending-project-ring')).toBeNull();
    expect(screen.queryByTestId('pending-project-frame')).toBeNull();
    collapseBar();
    expect(screen.queryByTestId('pending-project-frame')).toBeNull();

    // Another project's + moves it.
    expandBar();
    await user.click(createAgentButton('p-habits'));
    expect(screen.getByTestId('rose-project-row-p-habits')).toHaveAttribute('data-pending', 'true');
    expect(screen.getByTestId('rose-project-row-p-rose')).toHaveAttribute('data-pending', 'false');

    // The created (or a picked) agent becomes selected: nothing is pending, and
    // returning to the empty composer does not bring the stale mark back.
    rerender(<AppSidebar {...props('habits-done')} />);
    expect(screen.queryByTestId('pending-project-frame')).toBeNull();
    rerender(<AppSidebar {...props(null)} />);
    expect(screen.queryByTestId('pending-project-frame')).toBeNull();
  });

  it("the terminal's newAgentProjectId decides the pending project; Home + marks Home", async () => {
    const user = userEvent.setup();
    const base = defaultProps({ agents: AGENTS, user: signedInUser(), selectedAgentId: null });
    const { rerender } = renderWithProviders(
      <AppSidebar
        {...base}
        roseActions={{ onCreateAgentInProject: vi.fn(), newAgentProjectId: 'p-habits' }}
      />,
    );
    expandBar();
    await screen.findByTestId('rose-project-row-p-habits');
    expect(screen.getByTestId('rose-project-row-p-habits')).toHaveAttribute('data-pending', 'true');
    // The create request carried it and reset it to null (Home): no ring.
    rerender(
      <AppSidebar
        {...base}
        roseActions={{ onCreateAgentInProject: vi.fn(), newAgentProjectId: null }}
      />,
    );
    expect(screen.queryByTestId('pending-project-frame')).toBeNull();
    await user.click(createAgentButton('home'));
    expect(screen.getByTestId('rose-home-project-row')).toHaveAttribute('data-pending', 'true');
    expect(screen.queryByTestId('pending-project-ring')).toBeNull();
  });

  it('collapsed icons use the gray Bot glyph plus only the supported status glyphs', async () => {
    renderBar({ attentionAgentIds: new Set(['home-done']) });
    const row = (id: string) => screen.getByTestId(`rose-agent-row-${id}`);
    await waitFor(() => expect(row('home-run')).toBeInTheDocument());
    // Running = bot with an empty prediction ring until the model responds.
    expect(row('home-run').querySelector('[data-sidebar-agent-icon]')).not.toBeNull();
    expect(within(row('home-run')).getByRole('img', { name: 'Working' })).toBeInTheDocument();
    expect(within(row('home-run')).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
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

  it('Biz health covers the query box full width like Browser; admin bars prewarm it on mount', async () => {
    const user = userEvent.setup();
    const prewarm = vi.spyOn(adminHealthPrewarm, 'prewarmAdminHealth');
    const { unmount } = renderBar();
    expect(prewarm).not.toHaveBeenCalled();
    unmount();

    clearCaptures();
    renderBar({ showAdminHealth: true });
    // Prewarmed before any click: the backend's cold day build starts with the bar.
    expect(prewarm).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        capturedRequests.some(
          (r) => r.method === 'GET' && r.url.endsWith('/api/admin-health?timeSlice=monthly'),
        ),
      ).toBe(true),
    );
    await user.click(within(roseBar()).getByRole('button', { name: 'Biz health' }));
    const panel = screen.getByTestId('rose-app-panel');
    expect(panel).toHaveAttribute('data-variant', 'full');
    // From the left bar's live offset: the unpinned bar's 64px here.
    expect(resolvedLeft(panel)).toBe('64px');
    expect(panel.style.right).toBe('0px');
    expect(panel.style.width).toBe('');
    expect(screen.queryByTestId('app-drawer-resize-handle')).toBeNull();
    // Over the floating query box (z-[100]) and an open project settings drawer (z-[101]).
    expect(panel.className).toContain('z-[102]');
    expect(panel.parentElement).toBe(document.body);
    prewarm.mockRestore();
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
    // Member icon while the Rose profile loads, then the initial (useAccountProfileName).
    const initial = await within(account).findByTestId('rose-account-initial');
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
    // Embedded: hooked to the dark-only flat styling (roseSettings.css).
    expect(body.querySelector('.rose-settings')).not.toBeNull();
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
    expect(screen.getByTestId('rose-home-project-row').className).toContain('dark:text-[#a3a39d]');
    expect(within(bar).getByRole('button', { name: 'Archived' }).className).toContain(
      'dark:text-[#a3a39d]',
    );
    const bot = screen
      .getByTestId('rose-agent-row-home-run')
      .querySelector('[data-sidebar-agent-icon]')!;
    expect(bot.closest('button')?.className).toContain('dark:text-[#a3a39d]');
  });
});

// ─── Account row name from the Rose profile (ledger row 63) ─────────────────

const PROFILE_URL = 'http://localhost:3001/api/user-settings';

/** A phone-OTP sign-in: Supabase auth metadata carries no name. */
function phoneOnlyUser(): User {
  return { ...signedInUser(), user_metadata: {}, phone: '+19729777432' } as User;
}

function accountRow(name: string | RegExp) {
  return within(roseBar()).getByRole('button', { name });
}

function profileRequests(): number {
  return capturedRequests.filter(
    (r) => r.method === 'GET' && new URL(r.url).pathname === '/api/user-settings',
  ).length;
}

describe('Rose left bar account row: name from the Rose profile (row 63)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
    mockProjectsApi([]);
  });
  afterEach(() => localStorage.clear());

  it('profile name + empty auth metadata → "Andy Prevalsky" and the cursive "A"', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(PROFILE_URL, async () => {
        await gate;
        return HttpResponse.json({ name: 'Andy Prevalsky', phone: '+19729777432' });
      }),
    );
    renderWithProviders(<AppSidebar {...defaultProps({ agents: [], user: phoneOnlyUser() })} />);
    // Loading: the member icon fills the initial's 20px box (no layout shift).
    const loading = accountRow('+19729777432');
    const icon = within(loading).getByTestId('rose-account-member-icon');
    expect(icon).toHaveClass('h-5', 'w-5');
    expect(within(loading).queryByTestId('rose-account-initial')).toBeNull();

    release();
    const account = await waitFor(() => accountRow('Andy Prevalsky'));
    const initial = await within(account).findByTestId('rose-account-initial');
    expect(initial).toHaveTextContent('A');
    expect(initial).toHaveClass('h-5', 'w-5');
    expect(initial.style.fontFamily).toContain('Pinyon Script');
    expect(within(account).queryByTestId('rose-account-member-icon')).toBeNull();
    expect(profileRequests()).toBe(1);
  });

  it('the profile name wins over auth metadata', async () => {
    server.use(http.get(PROFILE_URL, () => HttpResponse.json({ name: 'Andrew P' })));
    renderWithProviders(
      <AppSidebar {...defaultProps({ agents: [], user: signedInUser('Metadata Name') })} />,
    );
    const account = await waitFor(() => accountRow('Andrew P'));
    expect(await within(account).findByTestId('rose-account-initial')).toHaveTextContent('A');
  });

  it('no profile name → auth metadata, then email local part, then phone', async () => {
    // Default handler: {} (no name).
    const { unmount } = renderWithProviders(
      <AppSidebar {...defaultProps({ agents: [], user: signedInUser('Grace Hopper') })} />,
    );
    const meta = await waitFor(() => accountRow('Grace Hopper'));
    expect(await within(meta).findByTestId('rose-account-initial')).toHaveTextContent('G');
    unmount();

    const emailUser = { ...phoneOnlyUser(), email: 'ada@example.com' } as User;
    const second = renderWithProviders(
      <AppSidebar {...defaultProps({ agents: [], user: emailUser })} />,
    );
    const email = await waitFor(() => accountRow('ada'));
    expect(await within(email).findByTestId('rose-account-initial')).toHaveTextContent('A');
    second.unmount();

    renderWithProviders(<AppSidebar {...defaultProps({ agents: [], user: phoneOnlyUser() })} />);
    const phone = accountRow('+19729777432');
    await waitFor(() => expect(profileRequests()).toBeGreaterThan(0));
    // "+" is not a letter: the member icon stays.
    await waitFor(() =>
      expect(within(phone).getByTestId('rose-account-member-icon')).toBeInTheDocument(),
    );
    expect(within(phone).queryByTestId('rose-account-initial')).toBeNull();
  });

  it('a failed profile request falls back to the auth metadata name', async () => {
    server.use(http.get(PROFILE_URL, () => HttpResponse.json({}, { status: 500 })));
    renderWithProviders(
      <AppSidebar {...defaultProps({ agents: [], user: signedInUser('Andy Prevalsky') })} />,
    );
    const account = accountRow('Andy Prevalsky');
    expect(await within(account).findByTestId('rose-account-initial')).toHaveTextContent('A');
  });

  it('anonymous: member icon and no profile request', async () => {
    renderWithProviders(<AppSidebar {...defaultProps({ agents: [], user: anonymousUser() })} />);
    const guest = accountRow('Guest');
    expect(within(guest).getByTestId('rose-account-member-icon')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(profileRequests()).toBe(0);
  });

  it('flag off: the stock sidebar makes no profile request', async () => {
    renderWithProviders(<AppSidebar {...defaultProps({ agents: [], user: phoneOnlyUser() })} />, {
      roseDesktop: false,
    });
    expect(screen.queryByTestId('rose-sidebar')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(profileRequests()).toBe(0);
  });
});
