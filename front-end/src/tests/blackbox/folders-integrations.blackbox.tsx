/**
 * Blackbox tests: Folders in the left bar (foundation contract: /api/folders).
 * Folders only organize agents (Andy, 2026-11-15); repositories are connected
 * or imported in Integrations › GitHub Repositories, never from the bar.
 *
 *   - folders keep existing project content: same ids, agents, subfolders and
 *     navigation after a rename (PATCH /api/folders/:id) and across a reload
 *   - creating a folder POSTs /api/folders with { name } only: never a repo
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RoseMobileAgentList } from '@/features/terminal-component-group/components/rose-sidebar/RoseMobileAgentList';

import { makeAgent, mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import { makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const ROSE_URL = 'https://github.com/Rose-Ai-Labs/rose';

function requests(method: string, path: string) {
  return capturedRequests.filter(
    (r) => r.method === method && new URL(r.url).pathname === `/api${path}`,
  );
}

const agents = [
  makeAgent({ agent_id: 'home-agent', goal: 'Home work', project_id: null }),
  makeAgent({ agent_id: 'rose-agent', goal: 'Rose work', project_id: 'p-rose' }),
  makeAgent({
    agent_id: 'ui-agent',
    goal: 'Interface work',
    project_id: 'p-rose',
    folder_id: 'f-ui',
  }),
];

function sidebar() {
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
      isLoading={false}
      isSearching={false}
      searchError={null}
    />
  );
}

function roseFolder() {
  return makeProject({ folders: [{ id: 'f-ui', name: 'Interface', projectId: 'p-rose' }] });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockSession();
  clearCaptures();
});
afterEach(() => localStorage.clear());

describe('Folders in the left bar', () => {
  it('a renamed folder keeps its id, agents, subfolders and navigation, also after a reload', async () => {
    const folders = mockProjectsApi([roseFolder()]);
    const user = userEvent.setup();
    const view = renderWithProviders(sidebar());
    const row = await screen.findByTestId('rose-project-row-p-rose');
    const group = screen.getByTestId('rose-group-p-rose');
    expect(within(group).getByText('Rose work')).toBeVisible();
    expect(
      within(screen.getByTestId('rose-folder-f-ui')).getByText('Interface work'),
    ).toBeVisible();

    fireEvent.contextMenu(row);
    await user.click(await screen.findByRole('menuitem', { name: 'Rename folder' }));
    const rename = await screen.findByRole('textbox', { name: 'Rename Rose' });
    await user.clear(rename);
    await user.type(rename, 'Rose app{Enter}');
    await waitFor(() => expect(row).toHaveTextContent('Rose app'));
    expect(folders.folderWrites).toEqual([
      { method: 'PATCH', id: 'p-rose', body: { name: 'Rose app' } },
    ]);
    expect(requests('PUT', '/projects/p-rose')).toHaveLength(0);

    // Reload: the same project row (folder alias) still holds its content.
    view.unmount();
    renderWithProviders(sidebar());
    const reloaded = await screen.findByTestId('rose-project-row-p-rose');
    expect(reloaded).toHaveTextContent('Rose app');
    expect(within(screen.getByTestId('rose-group-p-rose')).getByText('Rose work')).toBeVisible();
    expect(
      within(screen.getByTestId('rose-folder-f-ui')).getByText('Interface work'),
    ).toBeVisible();
    expect(folders.projects[0]).toMatchObject({ id: 'p-rose', repoUrl: ROSE_URL });
  });

  it('creating a folder sends { name } only: no repo or GitHub field, no repo connect', async () => {
    const folders = mockProjectsApi([roseFolder()]);
    const user = userEvent.setup();
    renderWithProviders(sidebar());
    await user.click(await screen.findByRole('button', { name: '+ New folder' }));
    // The create row is a name input only: nothing to pick a repo with.
    expect(screen.queryByRole('textbox', { name: /repo/i })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'New folder name' }), 'Website{Enter}');
    expect(await screen.findByTestId('rose-project-row-p-2')).toHaveTextContent('Website');
    expect(folders.folderWrites).toEqual([{ method: 'POST', id: null, body: { name: 'Website' } }]);
    expect(requests('POST', '/projects')).toHaveLength(0);
    expect(requests('POST', '/integrations/github/repos')).toHaveLength(0);
    expect(folders.projects[1]).toMatchObject({ name: 'Website', repoUrl: null });
  });
});
