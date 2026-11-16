/**
 * Blackbox tests for Rose Desktop folders in the left bar (UI ledger rows
 * 19/30/57/60) and the agent right-click menu (row 37), flag on.
 *
 * Folders only organize agents (Andy, 2026-11-15): no settings ⚙, no "Folder
 * settings" menu item and no repo avatar in the bar, and a repository connected
 * or imported in Integrations (isFolder: false) is not a folder. Project
 * settings are covered by project-settings.blackbox.tsx (Integrations ⚙).
 *
 * Projects API = backend contract feat/rose-user-ui @ ea032a02a (MSW in-memory
 * mock in rose-sidebar.fixtures.tsx, strict like the server):
 *   GET /api/projects -> { projects: ProjectDto[] } · POST /api/projects { name }
 *   (409 duplicate name) · PUT /api/projects/:id (edited subset only) · DELETE
 *   env files: GET/POST /api/projects/:id/env-files · DELETE …/env-files/:fileId
 *   agents: rows carry project_id (null = Home); POST /api/agents takes project_id
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { Toaster } from '@/components/ui/toaster';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import Terminal from '@/pages/Terminal';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';
import {
  createAgentButton,
  expandBar,
  findCreateAgentButton,
  expectAgentMenuEntries,
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
      makeAgent({
        agent_id: 'a-home',
        goal: 'Plan Tahoe trip',
        status: 'ACTIVE',
        temporal_workflow_id: 'wf',
        project_id: null,
      }),
      makeAgent({
        agent_id: 'a-rose',
        goal: 'Rose UI polish',
        project_id: 'p-rose',
        status: 'COMPLETED',
      }),
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
  return capturedRequests.filter(
    (r) => r.method === method && new URL(r.url).pathname === `/api${path}`,
  );
}

describe('Rose projects in the left bar', () => {
  let api: ReturnType<typeof mockProjectsApi>;
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
    api = mockProjectsApi([makeProject()]);
  });
  afterEach(() => localStorage.clear());

  it('reads { projects } and groups agents by project_id (null = Home)', async () => {
    renderBar();
    await screen.findByTestId('rose-project-row-p-rose');
    expect(
      within(screen.getByTestId('rose-group-p-rose')).getByTestId('rose-agent-row-a-rose'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('rose-group-home')).getByTestId('rose-agent-row-a-home'),
    ).toBeInTheDocument();
  });

  it('a repository from Integrations (isFolder: false) is not a folder; its agents show under Home', async () => {
    api = mockProjectsApi([
      makeProject(),
      makeProject({ id: 'p-repo', name: 'marketing-site', isFolder: false }),
    ]);
    renderBar({
      agents: [
        makeAgent({ agent_id: 'a-rose', goal: 'Rose UI polish', project_id: 'p-rose' }),
        makeAgent({ agent_id: 'a-repo', goal: 'Pricing copy', project_id: 'p-repo' }),
      ],
      user: signedInUser(),
    });
    const rose = await screen.findByTestId('rose-project-row-p-rose');
    expect(screen.queryByTestId('rose-project-row-p-repo')).toBeNull();
    expect(screen.queryByText('marketing-site')).toBeNull();
    expect(
      within(screen.getByTestId('rose-group-home')).getByTestId('rose-agent-row-a-repo'),
    ).toBeInTheDocument();
    // The folder row itself: plain folder icon, + and new subfolder, no settings.
    expect(within(rose).queryByRole('button', { name: /settings/i })).toBeNull();
    expect(rose.querySelector('img')).toBeNull();
    expect(rose.querySelector('svg.lucide-folder')).not.toBeNull();
    expect(screen.queryByTestId('rose-project-settings')).toBeNull();
  });

  it('+ New project heads the list, above every project; projects come before Home agents', async () => {
    api = mockProjectsApi([makeProject({ id: 'p-site', name: 'Website' }), makeProject()]);
    renderBar();
    const rose = await screen.findByTestId('rose-project-row-p-rose');
    const home = screen.getByTestId('rose-agent-row-a-home');
    const precedesHome = (node: Element) =>
      (node.compareDocumentPosition(home) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(precedesHome(rose)).toBe(true);
    expect(precedesHome(screen.getByTestId('rose-project-row-p-site'))).toBe(true);
    expect(precedesHome(screen.getByTestId('rose-agent-row-a-rose'))).toBe(true);
    const newProject = screen.getByRole('button', { name: '+ New folder' });
    expect(precedesHome(newProject)).toBe(true);
    for (const id of ['p-rose', 'p-site']) {
      const row = screen.getByTestId(`rose-project-row-${id}`);
      expect(
        newProject.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('+ New folder creates inline with POST /folders { name } only: Enter creates, Escape cancels', async () => {
    const user = userEvent.setup();
    renderBar();
    await screen.findByTestId('rose-project-row-p-rose');

    await user.click(screen.getByRole('button', { name: '+ New folder' }));
    const input = screen.getByRole('textbox', { name: 'New folder name' });
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, 'Scratch{Escape}');
    expect(screen.queryByRole('textbox', { name: 'New folder name' })).toBeNull();
    expect(requests('POST', '/folders')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '+ New folder' }));
    await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'Habits{Enter}');
    await waitFor(() => expect(requests('POST', '/folders')).toHaveLength(1));
    expect(requests('POST', '/folders')[0].body).toEqual({ name: 'Habits' });
    expect(api.folderWrites).toEqual([{ method: 'POST', id: null, body: { name: 'Habits' } }]);
    expect(await screen.findByTestId('rose-project-row-p-2')).toHaveTextContent('Habits');
    expect(screen.queryByRole('textbox', { name: 'New folder name' })).toBeNull();
    expect(screen.getByRole('button', { name: '+ New folder' })).toBeInTheDocument();
  });

  it('a duplicate name (409) keeps the inline input open with an inline error, no toast', async () => {
    const user = userEvent.setup();
    renderBar();
    await screen.findByTestId('rose-project-row-p-rose');

    await user.click(screen.getByRole('button', { name: '+ New folder' }));
    const input = screen.getByRole('textbox', { name: 'New folder name' });
    await user.type(input, 'Rose{Enter}');
    await waitFor(() => expect(requests('POST', '/folders')).toHaveLength(1));

    const error = await screen.findByTestId('rose-new-project-error');
    expect(error).toHaveTextContent('A folder named “Rose” already exists');
    expect(screen.getByRole('textbox', { name: 'New folder name' })).toHaveValue('Rose');
    expect(screen.getByRole('textbox', { name: 'New folder name' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.queryByText('Could not create folder')).toBeNull();
    expect(api.projects).toHaveLength(1);

    // Editing the name clears the error; a unique name then creates.
    await user.type(screen.getByRole('textbox', { name: 'New folder name' }), ' 2');
    expect(screen.queryByTestId('rose-new-project-error')).toBeNull();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(requests('POST', '/folders')).toHaveLength(2));
    expect(requests('POST', '/folders')[1].body).toEqual({ name: 'Rose 2' });
    expect(await screen.findByTestId('rose-project-row-p-2')).toHaveTextContent('Rose 2');
  });

  it('right-click a folder: exactly Rename folder (inline, PATCH /folders) | Delete folder (red)', async () => {
    const user = userEvent.setup();
    renderBar();
    const row = await screen.findByTestId('rose-project-row-p-rose');
    const menu = await openContextMenu(row, 'rose-project-menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Rename folder', 'Delete folder']);
    expect(items[1].className).toContain('text-[#e5484d]');

    await user.click(items[0]);
    const rename = await screen.findByRole('textbox', { name: 'Rename Rose' });
    await waitFor(() => expect(rename).toHaveFocus());
    await user.clear(rename);
    await user.type(rename, 'Rose Labs{Enter}');
    await waitFor(() => expect(requests('PATCH', '/folders/p-rose')).toHaveLength(1));
    expect(requests('PATCH', '/folders/p-rose')[0].body).toEqual({ name: 'Rose Labs' });
    expect(requests('PUT', '/projects/p-rose')).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByTestId('rose-project-row-p-rose')).toHaveTextContent('Rose Labs'),
    );
  });

  it('Delete folder asks to confirm, then DELETEs /folders/:id; its agents fall back to Home', async () => {
    const user = userEvent.setup();
    renderBar();
    const row = await screen.findByTestId('rose-project-row-p-rose');
    expect(
      within(screen.getByTestId('rose-group-p-rose')).getByTestId('rose-agent-row-a-rose'),
    ).toBeInTheDocument();
    const menu = await openContextMenu(row, 'rose-project-menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete folder' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete folder “Rose”?');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests('DELETE', '/folders/p-rose')).toHaveLength(0);

    await user.click(
      within(await openContextMenu(row, 'rose-project-menu')).getByRole('menuitem', {
        name: 'Delete folder',
      }),
    );
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete folder' }),
    );
    await waitFor(() => expect(requests('DELETE', '/folders/p-rose')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('rose-project-row-p-rose')).toBeNull());
    expect(api.projects).toHaveLength(0);
    expect(
      within(screen.getByTestId('rose-group-home')).getByTestId('rose-agent-row-a-rose'),
    ).toBeInTheDocument();
  });

  it('project + shows a not-yet toast until a handler is wired', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(await findCreateAgentButton('p-rose'));
    expect(
      await screen.findByText('New agent in a folder is not available yet'),
    ).toBeInTheDocument();
  });

  it('project + calls the provided handler with that project', async () => {
    const user = userEvent.setup();
    const onCreateAgentInProject = vi.fn();
    renderBar({ roseActions: { onCreateAgentInProject } });
    await user.click(await findCreateAgentButton('p-rose'));
    expect(onCreateAgentInProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-rose' }));
  });

  it('flag off: the stock bar never calls the Projects API', async () => {
    const { unmount } = renderWithProviders(<AppSidebar {...defaultProps()} />, {
      roseDesktop: false,
    });
    await waitFor(() => expect(screen.getByLabelText('Resize sidebar')).toBeInTheDocument());
    expect(requests('GET', '/projects')).toHaveLength(0);
    unmount();
  });
});

/** Signs in the flagged Rose Desktop account (the Terminal derives the flag from it). */
function mockRoseDesktopSession() {
  const user = { id: ROSE_DESKTOP_USER_IDS[0], is_anonymous: false };
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

describe('New agent from a project (Terminal)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockRoseDesktopSession();
    clearCaptures();
    mockProjectsApi([makeProject()]);
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
  });
  afterEach(() => localStorage.clear());

  function agentCreates() {
    return requests('POST', '/agents');
  }

  it("a project's + keeps its icon plain, passes project_id and the agent lands in that project; Home + does not", async () => {
    // A backend that keeps what was created: POST echoes the requested id and
    // project_id, and the list (GET /api/agents) returns those agents.
    const created: Record<string, unknown>[] = [];
    server.use(
      http.post(`${API_BASE}/agents`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        const agent = {
          ...makeAgent({
            agent_id: String(body.agent_id),
            goal: String(body.goal),
            status: 'STARTING_UP',
          }),
          project_id: (body.project_id as string | undefined) ?? null,
        };
        created.push(agent);
        return HttpResponse.json(agent);
      }),
      http.get(`${API_BASE}/agents`, () => HttpResponse.json({ agents: created })),
    );
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<Terminal />);
    await screen.findByTestId('rose-sidebar');
    expandBar();
    await user.click(await findCreateAgentButton('p-rose'));

    // The destination is tracked without highlighting the project's icon.
    expandBar();
    const rose = screen.getByTestId('rose-project-row-p-rose');
    expect(rose).toHaveAttribute('data-pending', 'true');
    expect(within(rose).queryByTestId('pending-project-ring')).toBeNull();

    const composer = await screen.findByPlaceholderText('Enter any goal');
    await user.click(composer);
    await user.type(composer, 'Fix the flaky sidebar test{Enter}');
    await waitFor(() => expect(agentCreates()).toHaveLength(1));
    expect(agentCreates()[0].body).toEqual(
      expect.objectContaining({ goal: 'Fix the flaky sidebar test', project_id: 'p-rose' }),
    );
    const firstId = String((agentCreates()[0].body as { agent_id: string }).agent_id);
    // The new agent is listed under Rose.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('rose-group-p-rose')).getByTestId(`rose-agent-row-${firstId}`),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('pending-project-frame')).toBeNull();

    expandBar();
    fireEvent.click(createAgentButton('home'));
    expect(screen.getByTestId('rose-home-project-row')).toHaveAttribute('data-pending', 'true');
    const home = await screen.findByPlaceholderText('Enter any goal');
    await user.click(home);
    await user.type(home, 'Plan Tahoe trip{Enter}');
    await waitFor(() => expect(agentCreates()).toHaveLength(2));
    expect(agentCreates()[1].body).toEqual(expect.objectContaining({ goal: 'Plan Tahoe trip' }));
    expect(agentCreates()[1].body).not.toHaveProperty('project_id');
    const secondId = String((agentCreates()[1].body as { agent_id: string }).agent_id);
    await waitFor(() =>
      expect(
        within(screen.getByTestId('rose-group-home')).getByTestId(`rose-agent-row-${secondId}`),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('pending-project-frame')).toBeNull();
  });
});

describe('Rose agent right-click menu', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
    mockProjectsApi([makeProject()]);
  });

  it('lists exactly Archive · Pin · Rename · Move to… · Copy (UI #26); removed items absent; Archive red', async () => {
    renderBar();
    const menu = await openContextMenu(
      await screen.findByTestId('rose-agent-row-a-home'),
      'rose-agent-menu',
    );
    expectAgentMenuEntries(menu, { move: true });
    expect(within(menu).getByRole('menuitem', { name: 'Archive agent' }).className).toContain(
      'text-[#e5484d]',
    );
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
    const menu = await openContextMenu(
      await screen.findByTestId('rose-agent-row-a-home'),
      'rose-agent-menu',
    );
    await user.click(within(menu).getByRole('menuitem', { name: 'Archive agent' }));
    await waitFor(() => expect(deleted).toBe('a-home'));
    await waitFor(() => expect(props.onRefreshAgents).toHaveBeenCalled());
  });

  it('Rename agent opens the existing rename dialog', async () => {
    const user = userEvent.setup();
    renderBar();
    const menu = await openContextMenu(
      await screen.findByTestId('rose-agent-row-a-home'),
      'rose-agent-menu',
    );
    await user.click(within(menu).getByRole('menuitem', { name: 'Rename agent' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('Copy › Copy agent ID writes the id to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderBar();
    const menu = await openContextMenu(
      await screen.findByTestId('rose-agent-row-a-home'),
      'rose-agent-menu',
    );
    const copy = within(menu).getByRole('menuitem', { name: 'Copy' });
    fireEvent.keyDown(copy, { key: 'ArrowRight' });
    const copyId = await screen.findByRole('menuitem', { name: 'Copy agent ID' });
    fireEvent.click(copyId);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('a-home'));
  });
});
