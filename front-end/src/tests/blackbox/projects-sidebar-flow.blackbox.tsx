/**
 * Original folder flow: inline sidebar groups/actions, shared by mobile.
 * Folders only organize agents (Andy, 2026-11-15): no settings ⚙, no
 * "Folder settings" menu item and no repo avatar in the bar; a repository
 * connected or imported in Integrations (isFolder: false) is not a folder.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { RoseMobileAgentList } from '@/features/terminal-component-group/components/rose-sidebar/RoseMobileAgentList';
import { renderWithProviders } from './test-wrapper';
import { mockSession, makeAgent } from './app-sidebar.fixtures';
import {
  expectAgentMenuEntries,
  makeProject,
  mockProjectsApi,
  openContextMenu,
} from './rose-sidebar.fixtures';
import { server } from './msw/server';
const api = 'http://localhost:3001/api';
beforeEach(() => {
  localStorage.clear();
  mockSession();
});
const listAgents = [
  makeAgent({ agent_id: 'home-agent', goal: 'Home work', project_id: null }),
  makeAgent({ agent_id: 'rose-agent', goal: 'Rose work', project_id: 'p-rose' }),
];
function mobileList({ agents = listAgents, isLoading = false } = {}) {
  return (
    <RoseMobileAgentList
      agents={agents}
      selectedAgentId={null}
      onSelectAgent={vi.fn()}
      onClose={vi.fn()}
      handlers={{
        onRenameAgent: vi.fn(),
        onCopyAgentLink: vi.fn(),
        onToggleAgentPin: vi.fn(),
        onArchiveAgent: vi.fn(),
      }}
      query=""
      contentMatchAgentIds={new Set()}
      isLoading={isLoading}
      isSearching={false}
      searchError={null}
    />
  );
}
function renderList() {
  return renderWithProviders(mobileList());
}
it('uses the original grouped folder rows with no settings, repo avatar or repository rows', async () => {
  mockProjectsApi([
    makeProject({ id: 'website', name: 'Website' }),
    makeProject(),
    // A repository connected in Integrations: not a folder; its agents stay in Home.
    makeProject({ id: 'p-repo', name: 'marketing-site', isFolder: false }),
  ]);
  renderWithProviders(
    mobileList({
      agents: [
        ...listAgents,
        makeAgent({ agent_id: 'repo-agent', goal: 'Repo work', project_id: 'p-repo' }),
      ],
    }),
  );
  const project = await screen.findByTestId('rose-project-row-p-rose');
  expect(screen.queryByRole('button', { name: /^Projects$/ })).toBeNull();
  expect(
    project.compareDocumentPosition(screen.getByTestId('rose-project-row-website')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(within(screen.getByTestId('rose-group-home')).getByText('Home work')).toBeVisible();
  expect(within(screen.getByTestId('rose-group-p-rose')).getByText('Rose work')).toBeVisible();
  expect(within(project).getByRole('button', { name: 'Create Super Agent' })).toBeVisible();
  expect(within(project).queryByRole('button', { name: /settings/i })).toBeNull();
  expect(project.querySelector('img')).toBeNull();
  expect(project.querySelector('svg.lucide-folder')).not.toBeNull();
  expect(screen.queryByTestId('rose-project-row-p-repo')).toBeNull();
  expect(screen.queryByText('marketing-site')).toBeNull();
  expect(within(screen.getByTestId('rose-group-home')).getByText('Repo work')).toBeVisible();
  expect(screen.queryByTestId('project-settings-content')).toBeNull();
});
it('creates inline with Enter and cancels with Escape; keeps a failed name for retry', async () => {
  const state = mockProjectsApi([makeProject()]);
  renderList();
  fireEvent.click(await screen.findByRole('button', { name: '+ New folder' }));
  let input = screen.getByRole('textbox', { name: 'New folder name' });
  fireEvent.change(input, { target: { value: 'Cancelled' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('textbox', { name: 'New folder name' })).toBeNull();
  expect(state.projects).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '+ New folder' }));
  input = screen.getByRole('textbox', { name: 'New folder name' });
  fireEvent.change(input, { target: { value: 'Website' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByText('Website')).toBeVisible();
  server.use(http.post(`${api}/folders`, () => new HttpResponse(null, { status: 503 })));
  fireEvent.click(screen.getByRole('button', { name: '+ New folder' }));
  input = screen.getByRole('textbox', { name: 'New folder name' });
  fireEvent.change(input, { target: { value: 'Keep this name' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not create folder');
  expect(screen.getByRole('textbox', { name: 'New folder name' })).toHaveValue('Keep this name');
});
it('keeps the list, inline project input and project menu mounted while agents refresh in the background', async () => {
  mockProjectsApi([makeProject()]);
  const view = renderWithProviders(mobileList({ agents: [], isLoading: true }));
  expect(screen.getByLabelText('Loading agents')).toBeVisible();
  view.rerender(mobileList());
  fireEvent.click(await screen.findByRole('button', { name: '+ New folder' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'New folder name' }), {
    target: { value: 'Website' },
  });
  // Defence in depth: even an isLoading refresh must not hide existing rows.
  view.rerender(mobileList({ isLoading: true }));
  expect(screen.queryByLabelText('Loading agents')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'New folder name' })).toHaveValue('Website');
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'New folder name' }), { key: 'Escape' });
  view.rerender(mobileList());
  const menu = await openContextMenu(
    screen.getByTestId('rose-project-row-p-rose'),
    'rose-project-menu',
  );
  view.rerender(mobileList({ isLoading: true }));
  expect(menu).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: 'Delete folder' })).toBeVisible();
});
it('surfaces a project read failure with Retry in the list', async () => {
  let failed = true;
  server.use(
    http.get(`${api}/projects`, () =>
      failed
        ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json({ projects: [makeProject()] }),
    ),
  );
  renderList();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load folders');
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry folders' }));
  expect(await screen.findByTestId('rose-project-row-p-rose')).toBeVisible();
});
it('keeps exactly Rename / Delete on the folder context menu (no Folder settings)', async () => {
  const state = mockProjectsApi([makeProject()]);
  renderList();
  await screen.findByTestId('rose-project-row-p-rose');
  const menu = await openContextMenu(
    screen.getByTestId('rose-project-row-p-rose'),
    'rose-project-menu',
  );
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent),
  ).toEqual(['Rename folder', 'Delete folder']);
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete folder' }));
  const confirm = screen.getByRole('alertdialog');
  expect(state.projects).toHaveLength(1);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
  expect(screen.getByTestId('rose-project-row-p-rose')).toBeVisible();
});
it('mobile agent rows open the same trimmed menu (UI #26): Archive · Pin · Rename · Copy', async () => {
  mockProjectsApi([makeProject()]);
  renderList();
  const row = await screen.findByTestId('rose-agent-row-rose-agent');
  expectAgentMenuEntries(await openContextMenu(row, 'rose-agent-menu'));
});
