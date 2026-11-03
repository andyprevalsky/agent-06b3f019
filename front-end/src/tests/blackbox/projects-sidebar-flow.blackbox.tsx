/** Original project flow: inline sidebar groups/actions, shared by mobile. */
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
it('uses the original grouped rows and gear settings instead of a separate Projects dashboard', async () => {
  mockProjectsApi([makeProject({ id: 'website', name: 'Website' }), makeProject()]);
  renderList();
  const project = await screen.findByTestId('rose-project-row-p-rose');
  expect(screen.queryByRole('button', { name: /^Projects$/ })).toBeNull();
  expect(
    project.compareDocumentPosition(screen.getByTestId('rose-project-row-website')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(within(screen.getByTestId('rose-group-home')).getByText('Home work')).toBeVisible();
  expect(within(screen.getByTestId('rose-group-p-rose')).getByText('Rose work')).toBeVisible();
  expect(within(project).getByRole('button', { name: 'Create Super Agent' })).toBeVisible();
  fireEvent.click(within(project).getByRole('button', { name: 'Rose project settings' }));
  expect(screen.queryByRole('button', { name: 'Download setup helper' })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Default branch' })).toHaveValue('main');
  expect(screen.getByRole('spinbutton', { name: 'Startup timeout (seconds)' })).toHaveValue(120);
  fireEvent.click(screen.getByRole('button', { name: 'Back to agents' }));
  expect(screen.getByTestId('rose-project-row-p-rose')).toBeVisible();
});
it('creates inline with Enter and cancels with Escape; keeps a failed name for retry', async () => {
  const state = mockProjectsApi([makeProject()]);
  renderList();
  fireEvent.click(await screen.findByRole('button', { name: '+ New project' }));
  let input = screen.getByRole('textbox', { name: 'New project name' });
  fireEvent.change(input, { target: { value: 'Cancelled' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('textbox', { name: 'New project name' })).toBeNull();
  expect(state.projects).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '+ New project' }));
  input = screen.getByRole('textbox', { name: 'New project name' });
  fireEvent.change(input, { target: { value: 'Website' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByText('Website')).toBeVisible();
  server.use(http.post(`${api}/projects`, () => new HttpResponse(null, { status: 503 })));
  fireEvent.click(screen.getByRole('button', { name: '+ New project' }));
  input = screen.getByRole('textbox', { name: 'New project name' });
  fireEvent.change(input, { target: { value: 'Keep this name' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not create project');
  expect(screen.getByRole('textbox', { name: 'New project name' })).toHaveValue('Keep this name');
});
it('keeps the list, inline project input and project menu mounted while agents refresh in the background', async () => {
  mockProjectsApi([makeProject()]);
  const view = renderWithProviders(mobileList({ agents: [], isLoading: true }));
  expect(screen.getByLabelText('Loading agents')).toBeVisible();
  view.rerender(mobileList());
  fireEvent.click(await screen.findByRole('button', { name: '+ New project' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'New project name' }), {
    target: { value: 'Website' },
  });
  // Defence in depth: even an isLoading refresh must not hide existing rows.
  view.rerender(mobileList({ isLoading: true }));
  expect(screen.queryByLabelText('Loading agents')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'New project name' })).toHaveValue('Website');
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'New project name' }), { key: 'Escape' });
  view.rerender(mobileList());
  const menu = await openContextMenu(
    screen.getByTestId('rose-project-row-p-rose'),
    'rose-project-menu',
  );
  view.rerender(mobileList({ isLoading: true }));
  expect(menu).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: 'Delete project' })).toBeVisible();
});
it('saves only changed repository fields from the existing gear settings', async () => {
  const state = mockProjectsApi([makeProject()]);
  renderList();
  fireEvent.click(await screen.findByRole('button', { name: 'Rose project settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Repository URL' }), {
    target: { value: 'https://github.com/example/repo' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(state.projects[0].repoUrl).toBe('https://github.com/example/repo'));
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
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load projects');
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry projects' }));
  expect(await screen.findByTestId('rose-project-row-p-rose')).toBeVisible();
});
it('keeps Rename / Settings / Delete on the existing project context menu', async () => {
  const state = mockProjectsApi([makeProject()]);
  renderList();
  await screen.findByTestId('rose-project-row-p-rose');
  const menu = await openContextMenu(
    screen.getByTestId('rose-project-row-p-rose'),
    'rose-project-menu',
  );
  expect(within(menu).getByRole('menuitem', { name: 'Rename project' })).toBeVisible();
  expect(within(menu).getByRole('menuitem', { name: 'Project settings' })).toBeVisible();
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete project' }));
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
