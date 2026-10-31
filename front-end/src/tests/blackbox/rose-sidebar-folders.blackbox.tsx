/** One-level project folders in the shared desktop/mobile sidebar. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  signedInUser,
} from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';
import { FolderAgentCount } from '@/features/terminal-component-group/components/rose-sidebar/RoseProjectFolders';
const API_BASE = 'http://localhost:3001/api';
function renderBar(overrides: Parameters<typeof defaultProps>[0] = {}) {
  const props = defaultProps({ user: signedInUser(), ...overrides });
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

describe('one-level folders inside projects', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
  });
  const folder = { id: 'f-ui', name: 'Interface', projectId: 'p-rose' };
  const agents = [
    makeAgent({ agent_id: 'root-agent', goal: 'Root work', project_id: 'p-rose' }),
    makeAgent({
      agent_id: 'folder-agent',
      goal: 'Folder work',
      project_id: 'p-rose',
      folder_id: 'f-ui',
    }),
  ];

  it('nests agents once, collapses folders, and creates in the selected folder or project root', async () => {
    mockProjectsApi([makeProject({ folders: [folder] })]);
    const create = vi.fn();
    renderBar({ agents, roseActions: { onCreateAgentInProject: create } });
    const group = await screen.findByTestId('rose-folder-f-ui');
    expect(within(group).getByText('Folder work')).toBeVisible();
    expect(within(group).queryByText('Root work')).toBeNull();
    const user = userEvent.setup();
    fireEvent.click(within(group).getByRole('button', { name: 'Collapse folder Interface' }));
    expect(within(group).queryByText('Folder work')).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Expand folder Interface' }));
    expect(within(group).getByText('Folder work')).toBeVisible();
    fireEvent.click(within(group).getByRole('button', { name: 'Create Super Agent in Interface' }));
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'p-rose' }), 'f-ui');
    await user.click(
      within(screen.getByTestId('rose-project-row-p-rose')).getByRole('button', {
        name: 'Create Super Agent',
      }),
    );
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'p-rose' }));
    expect(within(group).queryByRole('button', { name: /New folder/ })).toBeNull();
  });

  it('creates and renames folders inline, reports duplicate names, and deletes only after confirmation', async () => {
    const api = mockProjectsApi([makeProject({ folders: [folder] })]);
    renderBar({ agents });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New folder in Rose' }));
    let input = screen.getByRole('textbox', { name: 'New folder name' });
    await user.type(input, 'Interface{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A folder with this name already exists',
    );
    await user.clear(input);
    await user.type(input, 'Research{Enter}');
    const created = await screen.findByTestId('rose-folder-f-2');
    expect(created).toHaveTextContent('No agents yet');
    expect(api.projects[0].folders).toHaveLength(2);
    await user.click(within(created).getByRole('button', { name: 'Research folder options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename folder' }));
    input = screen.getByRole('textbox', { name: 'Rename folder' });
    await user.clear(input);
    await user.type(input, 'Discoveries{Enter}');
    await waitFor(() =>
      expect(screen.getByTestId('rose-folder-f-2')).toHaveTextContent('Discoveries'),
    );
    await user.click(
      within(screen.getByTestId('rose-folder-f-ui')).getByRole('button', {
        name: 'Interface folder options',
      }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete folder' }));
    expect(requests('DELETE', '/projects/p-rose/folders/f-ui')).toHaveLength(0);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Its agents stay in Rose');
    await user.click(within(dialog).getByRole('button', { name: 'Delete folder' }));
    await waitFor(() => expect(screen.queryByTestId('rose-folder-f-ui')).toBeNull());
    expect(screen.getByTestId('rose-group-p-rose')).toHaveTextContent('Folder work');
    expect(screen.getByTestId('rose-group-home')).not.toHaveTextContent('Folder work');
  });

  it('keeps a failed folder create editable and supports cancellation', async () => {
    mockProjectsApi([makeProject()]);
    server.use(
      http.post(
        `${API_BASE}/projects/p-rose/folders`,
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    renderBar();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New folder in Rose' }));
    const input = screen.getByRole('textbox', { name: 'New folder name' });
    await user.type(input, 'Keep me{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save folder');
    expect(input).toHaveValue('Keep me');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'New folder name' })).toBeNull();
  });

  const orderedFolders = [
    folder,
    { id: 'f-doc', name: 'Documents', projectId: 'p-rose' },
    { id: 'f-api', name: 'Services', projectId: 'p-rose' },
  ];
  const folderOrder = () =>
    screen.getAllByTestId(/^rose-folder-/).map((row) => row.getAttribute('data-testid'));

  it('moves folders from the menu, disables boundaries, and saves the moved folder position', async () => {
    const api = mockProjectsApi([makeProject({ folders: orderedFolders })]);
    renderBar({ agents });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Interface folder options' }));
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
    await user.click(screen.getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() =>
      expect(folderOrder()).toEqual(['rose-folder-f-doc', 'rose-folder-f-ui', 'rose-folder-f-api']),
    );
    expect(api.projects[0].folders?.map((f) => f.id)).toEqual(['f-doc', 'f-ui', 'f-api']);
    expect(requests('PUT', '/projects/p-rose/folders/f-ui/position')[0].body).toEqual({
      beforeId: 'f-api',
    });
    await user.click(screen.getByRole('button', { name: 'Services folder options' }));
    expect(screen.getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() =>
      expect(folderOrder()).toEqual(['rose-folder-f-doc', 'rose-folder-f-api', 'rose-folder-f-ui']),
    );
    expect(screen.getByTestId('rose-folder-f-ui')).toHaveTextContent('Folder work');
  });

  it('drags a folder above another and restores the saved order when a write fails', async () => {
    mockProjectsApi([makeProject({ folders: orderedFolders })]);
    renderBar({ agents });
    const row = (id: string) =>
      screen.getByTestId(`rose-folder-${id}`).querySelector('[draggable]')!;
    await screen.findByTestId('rose-folder-f-api');
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(row('f-api'), { dataTransfer });
    fireEvent.dragOver(row('f-ui'), { dataTransfer });
    fireEvent.drop(row('f-ui'), { dataTransfer });
    await waitFor(() =>
      expect(requests('PUT', '/projects/p-rose/folders/f-api/position')).toHaveLength(1),
    );
    await waitFor(() =>
      expect(folderOrder()).toEqual(['rose-folder-f-api', 'rose-folder-f-ui', 'rose-folder-f-doc']),
    );
    server.use(
      http.put(
        `${API_BASE}/projects/p-rose/folders/:folderId/position`,
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    fireEvent.dragStart(row('f-doc'), { dataTransfer });
    fireEvent.drop(row('f-api'), { dataTransfer });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reorder folders');
    await waitFor(() =>
      expect(folderOrder()).toEqual(['rose-folder-f-api', 'rose-folder-f-ui', 'rose-folder-f-doc']),
    );
  });

  it('collapses projects and Home independently by icon, including in the narrow rail, and remembers the choice', async () => {
    mockProjectsApi([makeProject({ folders: [folder] })]);
    renderBar({
      agents: [
        ...agents,
        makeAgent({ agent_id: 'home-agent', goal: 'Home work', project_id: null }),
      ],
    });
    const user = userEvent.setup();
    const project = await screen.findByRole('button', { name: 'Collapse Rose project' });
    await user.click(project);
    expect(screen.getByTestId('rose-group-p-rose')).not.toBeVisible();
    expect(screen.getByTestId('rose-group-home')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Expand Rose project' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    collapseBar();
    await user.click(screen.getByRole('button', { name: 'Collapse Home project' }));
    expect(screen.getByTestId('rose-group-home')).not.toBeVisible();
    expect(JSON.parse(localStorage.getItem('rose:collapsed-projects')!)).toEqual([
      'p-rose',
      'home',
    ]);
    await user.click(screen.getByRole('button', { name: 'Expand Rose project' }));
    expect(screen.getByTestId('rose-group-p-rose')).toBeVisible();
    expect(screen.getByTestId('rose-group-home')).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Expand Home project' }));
    expect(screen.getByTestId('rose-group-home')).toBeVisible();
  });

  it('keeps collapse preferences unchanged while search exposes matching groups', async () => {
    mockProjectsApi([makeProject({ folders: [folder] })]);
    renderBar({
      agents: [
        ...agents,
        makeAgent({ agent_id: 'home-agent', goal: 'Home work', project_id: null }),
      ],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Collapse Rose project' }));
    const saved = localStorage.getItem('rose:collapsed-projects');
    const search = screen.getByRole('searchbox', { name: 'Search agents' });
    await user.type(search, 'work');
    const project = screen.getByRole('button', { name: 'Collapse Rose project' });
    const home = screen.getByRole('button', { name: 'Collapse Home project' });
    expect(project).toBeDisabled();
    expect(home).toBeDisabled();
    await user.click(project);
    await user.click(home);
    expect(localStorage.getItem('rose:collapsed-projects')).toBe(saved);
    await user.clear(search);
    expect(screen.getByTestId('rose-group-p-rose')).not.toBeVisible();
    expect(screen.getByTestId('rose-group-home')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Expand Rose project' })).toBeEnabled();
  });

  it.each([0, 7, 42, 128, 999, 1234])(
    'places the %i-agent count within the folder icon with the full accessible count',
    (count) => {
      renderWithProviders(<FolderAgentCount count={count} active={false} />);
      const icon = screen.getByRole('img', { name: `${count} agents` });
      expect(within(icon).getByTestId('folder-agent-count')).toHaveTextContent(
        count > 999 ? '999+' : String(count),
      );
      expect(icon.querySelector('svg')).toBeInTheDocument();
    },
  );
});
