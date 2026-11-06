/**
 * Blackbox: Rose Desktop left bar, agent right-click › Move to… (Andy 2026-11-06:
 * "i should be able to right click an agent, and move it's folder location").
 *
 * Backend contract (PATCH /api/agents/:id, agentProject.ts placement resolver):
 *   { project_id: P } -> project root · { folder_id: F } -> folder (project derived)
 *   { project_id: null } -> Home. Response { agent } carries project_id/folder_id.
 * The row regroups optimistically, one PATCH per move, no agent-list refetch;
 * a failed PATCH restores the original group and toasts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { Toaster } from '@/components/ui/toaster';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';
import {
  collapseBar,
  expandBar,
  makeProject,
  mockProjectsApi,
  openContextMenu,
  signedInUser,
} from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';
const folder = { id: 'f-ui', name: 'Interface', projectId: 'p-rose' };

function renderBar() {
  const props = defaultProps({
    agents: [
      makeAgent({ agent_id: 'a-home', goal: 'Plan Tahoe trip', project_id: null }),
      makeAgent({ agent_id: 'a-rose', goal: 'Rose UI polish', project_id: 'p-rose' }),
    ],
    user: signedInUser(),
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

function patches() {
  return capturedRequests.filter(
    (r) => r.method === 'PATCH' && new URL(r.url).pathname.startsWith('/api/agents/'),
  );
}

/** PATCH mock that answers like the backend, or fails once `fail` is set. */
function mockPatch(options: { fail?: boolean; gate?: Promise<void> } = {}) {
  server.use(
    http.patch(`${API_BASE}/agents/:agentId`, async ({ request, params }) => {
      const body = (await request.json()) as { project_id?: string | null; folder_id?: string };
      if (options.gate) await options.gate;
      if (options.fail) return HttpResponse.json({ error: 'boom' }, { status: 500 });
      const folderId = body.folder_id ?? null;
      const projectId = folderId !== null ? 'p-rose' : (body.project_id ?? null);
      return HttpResponse.json({
        agent: { agent_id: String(params.agentId), project_id: projectId, folder_id: folderId },
      });
    }),
  );
}

async function openMoveMenu(agentId: string) {
  const menu = await openContextMenu(
    await screen.findByTestId(`rose-agent-row-${agentId}`),
    'rose-agent-menu',
  );
  const trigger = within(menu).getByRole('menuitem', { name: 'Move to…' });
  fireEvent.keyDown(trigger, { key: 'ArrowRight' });
  return await screen.findByRole('menuitem', { name: 'Home' });
}

const inGroup = (groupTestId: string, agentId: string) =>
  within(screen.getByTestId(groupTestId)).queryByTestId(`rose-agent-row-${agentId}`);

describe('Rose agent right-click › Move to…', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
    mockProjectsApi([
      makeProject({ folders: [folder] }),
      makeProject({ id: 'p-web', name: 'Web' }),
    ]);
  });

  it('lists every project with its folders, then Home; the current location is checked and disabled', async () => {
    mockPatch();
    renderBar();
    await screen.findByTestId('rose-project-row-p-web');
    const home = await openMoveMenu('a-home');
    const sub = home.closest('[role="menu"]') as HTMLElement;
    expect(
      within(sub)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Rose', 'Interface', 'Web', 'Home']);
    expect(home).toHaveAttribute('aria-disabled', 'true');
    expect(home).toHaveAttribute('aria-current', 'location');
    expect(within(sub).getByRole('menuitem', { name: 'Web' })).not.toHaveAttribute('aria-disabled');
    fireEvent.click(home);
    expect(patches()).toHaveLength(0);
  });

  it('moves a Home agent into a project with one PATCH and no list refetch', async () => {
    mockPatch();
    const props = renderBar();
    await screen.findByTestId('rose-project-row-p-web');
    await openMoveMenu('a-home');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Web' }));
    await waitFor(() => expect(inGroup('rose-group-p-web', 'a-home')).not.toBeNull());
    expect(inGroup('rose-group-home', 'a-home')).toBeNull();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(new URL(patches()[0].url).pathname).toBe('/api/agents/a-home');
    expect(patches()[0].body).toEqual({ project_id: 'p-web' });
    expect(props.onRefreshAgents).not.toHaveBeenCalled();
    // The destination may be collapsed, so the move is confirmed by name.
    expect(await screen.findByText('Moved to Web')).toBeInTheDocument();
  });

  it('ignores a second move of the same agent while the first is still saving', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockPatch({ gate });
    renderBar();
    await screen.findByTestId('rose-project-row-p-web');
    // Toast state is module-level (use-toast), so this test's toast text must
    // differ from the previous test's "Moved to Web".
    await openMoveMenu('a-home');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rose' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    await openMoveMenu('a-home');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Web' }));
    release();
    expect(await screen.findByText('Moved to Rose')).toBeInTheDocument();
    expect(patches()).toHaveLength(1);
    expect(patches()[0].body).toEqual({ project_id: 'p-rose' });
    expect(inGroup('rose-group-p-rose', 'a-home')).not.toBeNull();
    expect(inGroup('rose-group-p-web', 'a-home')).toBeNull();
  });

  it('moves a project agent to Home and into a folder (keyboard only)', async () => {
    mockPatch();
    renderBar();
    await screen.findByTestId('rose-project-row-p-web');
    const home = await openMoveMenu('a-rose');
    fireEvent.keyDown(home, { key: 'Enter' });
    await waitFor(() => expect(inGroup('rose-group-home', 'a-rose')).not.toBeNull());
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ project_id: null });

    const folderItem = (await openMoveMenu('a-rose')).closest('[role="menu"]') as HTMLElement;
    fireEvent.keyDown(within(folderItem).getByRole('menuitem', { name: 'Interface' }), {
      key: 'Enter',
    });
    await waitFor(() =>
      expect(
        within(screen.getByTestId('rose-folder-f-ui')).queryByTestId('rose-agent-row-a-rose'),
      ).not.toBeNull(),
    );
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1].body).toEqual({ folder_id: 'f-ui' });
  });

  it('shows the move at once, then rolls back with an error toast when the PATCH fails', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockPatch({ fail: true, gate });
    renderBar();
    await screen.findByTestId('rose-project-row-p-web');
    await openMoveMenu('a-home');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rose' }));
    await waitFor(() => expect(inGroup('rose-group-p-rose', 'a-home')).not.toBeNull());
    expect(inGroup('rose-group-home', 'a-home')).toBeNull();
    release();
    expect(await screen.findByText('Failed to move agent')).toBeInTheDocument();
    await waitFor(() => expect(inGroup('rose-group-home', 'a-home')).not.toBeNull());
    expect(inGroup('rose-group-p-rose', 'a-home')).toBeNull();
  });

  it('the collapsed bar offers Move to… on agent rows too', async () => {
    mockPatch();
    renderBar();
    await screen.findByTestId('rose-project-row-p-web');
    collapseBar();
    await openMoveMenu('a-home');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Web' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ project_id: 'p-web' });
  });
});
