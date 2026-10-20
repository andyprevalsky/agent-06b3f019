/**
 * Blackbox tests for Rose Desktop projects in the left bar (UI ledger rows
 * 19/30/57/60) and the agent right-click menu (row 37), flag on.
 *
 * Projects API shape (typed client lib/api/projects.ts, MSW in-memory list):
 *   GET /api/projects -> [{ id, name, defaultBranch, repoUrl, startupScript,
 *     startupTimeoutSec, envFiles: [{ path, description }], autoWake }]
 *   POST /api/projects { name } · PATCH /api/projects/:id · DELETE /api/projects/:id
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { Toaster } from '@/components/ui/toaster';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';
import {
  expandBar,
  makeProject,
  mockProjectsApi,
  openContextMenu,
  signedInUser,
} from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';

function renderBar(overrides: Parameters<typeof defaultProps>[0] = {}) {
  const props = defaultProps({
    agents: [
      makeAgent({ agent_id: 'a-home', goal: 'Plan Tahoe trip', status: 'ACTIVE', temporal_workflow_id: 'wf' }),
      makeAgent({ agent_id: 'a-rose', goal: 'Rose UI polish', project_id: 'p-rose', status: 'COMPLETED' }),
    ],
    user: signedInUser(),
    ...overrides,
  });
  renderWithProviders(
    <>
      <AppSidebar {...props} />
      <Toaster />
    </>,
  );
  expandBar();
  return props;
}

function requests(method: string, path: string) {
  return capturedRequests.filter((r) => r.method === method && new URL(r.url).pathname === `/api${path}`);
}

describe('Rose projects in the left bar', () => {
  let projects: ReturnType<typeof mockProjectsApi>;
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
    projects = mockProjectsApi([makeProject()]);
  });
  afterEach(() => localStorage.clear());

  it('+ New project creates inline: Enter creates, Escape cancels', async () => {
    const user = userEvent.setup();
    renderBar();
    await screen.findByTestId('rose-project-row-p-rose');

    await user.click(screen.getByRole('button', { name: '+ New project' }));
    const input = screen.getByRole('textbox', { name: 'New project name' });
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, 'Scratch{Escape}');
    expect(screen.queryByRole('textbox', { name: 'New project name' })).toBeNull();
    expect(requests('POST', '/projects')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '+ New project' }));
    await user.type(screen.getByRole('textbox', { name: 'New project name' }), 'Habits{Enter}');
    await waitFor(() => expect(requests('POST', '/projects')).toHaveLength(1));
    expect(requests('POST', '/projects')[0].body).toEqual({ name: 'Habits' });
    expect(await screen.findByTestId('rose-project-row-p-2')).toHaveTextContent('Habits');
    expect(screen.getByRole('button', { name: '+ New project' })).toBeInTheDocument();
  });

  it('right-click a project: Rename project (inline), Project settings, Delete project (red)', async () => {
    const user = userEvent.setup();
    renderBar();
    const row = await screen.findByTestId('rose-project-row-p-rose');
    const menu = await openContextMenu(row, 'rose-project-menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Rename project', 'Project settings', 'Delete project']);
    expect(items[2].className).toContain('text-[#e5484d]');

    await user.click(items[0]);
    const rename = await screen.findByRole('textbox', { name: 'Rename Rose' });
    await waitFor(() => expect(rename).toHaveFocus());
    await user.clear(rename);
    await user.type(rename, 'Rose Labs{Enter}');
    await waitFor(() => expect(requests('PATCH', '/projects/p-rose')).toHaveLength(1));
    expect(requests('PATCH', '/projects/p-rose')[0].body).toEqual({ name: 'Rose Labs' });
    await waitFor(() => expect(screen.getByTestId('rose-project-row-p-rose')).toHaveTextContent('Rose Labs'));
  });

  it('Delete project asks to confirm, then deletes; its agents fall back to Home', async () => {
    const user = userEvent.setup();
    renderBar();
    const row = await screen.findByTestId('rose-project-row-p-rose');
    expect(within(screen.getByTestId('rose-group-p-rose')).getByTestId('rose-agent-row-a-rose')).toBeInTheDocument();
    const menu = await openContextMenu(row, 'rose-project-menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete project' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete project “Rose”?');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests('DELETE', '/projects/p-rose')).toHaveLength(0);

    await user.click(within(await openContextMenu(row, 'rose-project-menu')).getByRole('menuitem', { name: 'Delete project' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(requests('DELETE', '/projects/p-rose')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('rose-project-row-p-rose')).toBeNull());
    expect(projects).toHaveLength(0);
    expect(within(screen.getByTestId('rose-group-home')).getByTestId('rose-agent-row-a-rose')).toBeInTheDocument();
  });

  it('project + shows a not-yet toast until a handler is wired', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(await screen.findByRole('button', { name: 'New agent in Rose' }));
    expect(await screen.findByText('New agent in a project is not available yet')).toBeInTheDocument();
  });

  it('project + calls the provided handler with that project', async () => {
    const user = userEvent.setup();
    const onCreateAgentInProject = vi.fn();
    renderBar({ roseActions: { onCreateAgentInProject } });
    await user.click(await screen.findByRole('button', { name: 'New agent in Rose' }));
    expect(onCreateAgentInProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-rose' }));
  });

  it('⚙ opens project settings beside the bar with every section; ⚙ again closes it', async () => {
    const user = userEvent.setup();
    renderBar();
    const gear = await screen.findByRole('button', { name: 'Rose project settings' });
    await user.click(gear);
    const panel = screen.getByTestId('rose-project-settings');
    expect(panel.style.left).toBe('236px');
    expect(panel.className).toContain('dark:bg-[#262624]');
    expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent('Rose');

    const repo = within(panel).getByRole('region', { name: 'Code repo' });
    expect(repo).toHaveTextContent('https://github.com/Rose-Ai-Labs/rose');
    expect(within(repo).getByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(within(repo).getByRole('textbox', { name: 'Default branch' })).toHaveValue('main');
    expect(within(repo).getByTestId('project-github-status')).toHaveTextContent('Connected');

    expect(within(panel).getByRole('textbox', { name: 'Startup script' })).toHaveValue(
      'sudo service postgresql start || true',
    );
    expect(within(panel).getByRole('spinbutton', { name: 'Startup timeout (seconds)' })).toHaveValue(120);

    const env = within(panel).getByRole('region', { name: 'Environment files' });
    expect(env).toHaveTextContent('Environment files · 2');
    expect(within(env).getAllByTestId('project-env-file')).toHaveLength(2);
    await user.type(within(env).getByRole('searchbox', { name: 'Search environment files' }), 'backend');
    expect(within(env).getAllByTestId('project-env-file')).toHaveLength(1);
    await user.clear(within(env).getByRole('searchbox', { name: 'Search environment files' }));
    await user.click(within(env).getByRole('button', { name: 'Expand agents/.env' }));
    expect(within(env).getByRole('textbox', { name: 'Description of agents/.env' })).toHaveValue('Agent worker secrets');
    expect(within(env).getByRole('button', { name: 'Remove agents/.env' })).toBeInTheDocument();
    expect(within(env).getByRole('button', { name: '+ Add a file' })).toBeInTheDocument();

    const lifecycle = within(panel).getByRole('region', { name: 'Lifecycle' });
    expect(within(lifecycle).getByRole('button', { name: 'Auto-wake' })).toHaveAttribute('aria-pressed', 'true');
    expect(lifecycle).toHaveTextContent('Startup script');
    expect(lifecycle).toHaveTextContent('set');

    // Working in the panel collapses the bar (pointer left it); hover back to reach ⚙.
    expandBar();
    await user.click(screen.getByRole('button', { name: 'Rose project settings' }));
    expect(screen.queryByTestId('rose-project-settings')).toBeNull();
  });

  it('Save PATCHes only the edited fields (timeout, env files, auto-wake, repo)', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(await screen.findByRole('button', { name: 'Rose project settings' }));
    const panel = screen.getByTestId('rose-project-settings');
    const save = within(panel).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    const timeout = within(panel).getByRole('spinbutton', { name: 'Startup timeout (seconds)' });
    await user.clear(timeout);
    await user.type(timeout, '300');
    await user.click(within(panel).getByRole('button', { name: 'Remove back-end/.env' }));
    await user.click(within(panel).getByRole('button', { name: '+ Add a file' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Path of file 2' }), 'front-end/.env');
    await user.click(within(panel).getByRole('button', { name: 'Auto-wake' }));
    await user.click(within(panel).getByRole('button', { name: 'Change' }));
    const url = within(panel).getByRole('textbox', { name: 'Repository URL' });
    await user.clear(url);
    await user.type(url, 'https://github.com/Rose-Ai-Labs/rose-v2');

    await user.click(save);
    await waitFor(() => expect(requests('PATCH', '/projects/p-rose')).toHaveLength(1));
    expect(requests('PATCH', '/projects/p-rose')[0].body).toEqual({
      repoUrl: 'https://github.com/Rose-Ai-Labs/rose-v2',
      startupTimeoutSec: 300,
      autoWake: false,
      envFiles: [
        { path: 'agents/.env', description: 'Agent worker secrets' },
        { path: 'front-end/.env', description: '' },
      ],
    });
    await waitFor(() => expect(save).toBeDisabled());
  });

  it('flag off: the stock bar never calls the Projects API', async () => {
    const { unmount } = renderWithProviders(<AppSidebar {...defaultProps()} />, { roseDesktop: false });
    await waitFor(() => expect(screen.getByLabelText('Resize sidebar')).toBeInTheDocument());
    expect(requests('GET', '/projects')).toHaveLength(0);
    unmount();
  });
});

describe('Rose agent right-click menu', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
    mockProjectsApi([makeProject()]);
  });

  it('lists the boxes.dev-style items in order; destructive items red', async () => {
    renderBar();
    const menu = await openContextMenu(await screen.findByTestId('rose-agent-row-a-home'), 'rose-agent-menu');
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual([
      'New agent in this branchsame E2B session',
      'Archive agent',
      'Mark unread',
      'Mute notifications',
      'Pin agent',
      'Rename agent',
      'Share agent',
      'Delete agent',
      'Schedule a prompt…',
      'Copy',
    ]);
    expect(within(menu).getByRole('menuitem', { name: 'Archive agent' }).className).toContain('text-[#e5484d]');
    expect(within(menu).getByRole('menuitem', { name: 'Delete agent' }).className).toContain('text-[#e5484d]');
    expect(within(menu).getAllByRole('separator').length).toBeGreaterThanOrEqual(4);
    expect(menu.className).toContain('dark:bg-[#2f2f2c]');
  });

  it('Archive agent uses the existing archive (soft delete) and refreshes the list', async () => {
    const user = userEvent.setup();
    let deleted = '';
    server.use(
      http.delete(`${API_BASE}/agents/:agentId`, ({ params }) => {
        deleted = String(params.agentId);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const props = renderBar();
    const menu = await openContextMenu(await screen.findByTestId('rose-agent-row-a-home'), 'rose-agent-menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Archive agent' }));
    await waitFor(() => expect(deleted).toBe('a-home'));
    await waitFor(() => expect(props.onRefreshAgents).toHaveBeenCalled());
  });

  it('Rename agent opens the existing rename dialog', async () => {
    const user = userEvent.setup();
    renderBar();
    const menu = await openContextMenu(await screen.findByTestId('rose-agent-row-a-home'), 'rose-agent-menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Rename agent' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('unbuilt items show a clear not-yet toast; provided handlers are called instead', async () => {
    const user = userEvent.setup();
    renderBar();
    const row = await screen.findByTestId('rose-agent-row-a-home');
    for (const [item, toast] of [
      ['New agent in this branch', 'New agent in this branch is not available yet'],
      ['Mark unread', 'Mark unread is not available yet'],
      ['Mute notifications', 'Mute notifications is not available yet'],
      ['Share agent', 'Share agent is not available yet'],
      ['Delete agent', 'Delete agent is not available yet'],
      ['Schedule a prompt…', 'Schedule a prompt is not available yet'],
    ] as const) {
      const menu = await openContextMenu(row, 'rose-agent-menu');
      await user.click(within(menu).getByRole('menuitem', { name: new RegExp(`^${item}`) }));
      expect(await screen.findByText(toast)).toBeInTheDocument();
    }
  });

  it('a provided roseActions handler replaces the toast', async () => {
    const user = userEvent.setup();
    const onNewAgentInBranch = vi.fn();
    renderBar({ roseActions: { onNewAgentInBranch } });
    const menu = await openContextMenu(await screen.findByTestId('rose-agent-row-a-home'), 'rose-agent-menu');
    await user.click(within(menu).getByRole('menuitem', { name: /^New agent in this branch/ }));
    expect(onNewAgentInBranch).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'a-home' }));
  });

  it('Copy › Copy agent ID writes the id to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderBar();
    const menu = await openContextMenu(await screen.findByTestId('rose-agent-row-a-home'), 'rose-agent-menu');
    const copy = within(menu).getByRole('menuitem', { name: 'Copy' });
    fireEvent.keyDown(copy, { key: 'ArrowRight' });
    const copyId = await screen.findByRole('menuitem', { name: 'Copy agent ID' });
    fireEvent.click(copyId);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('a-home'));
  });
});
