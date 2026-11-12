/**
 * Blackbox tests: Folders replace Projects in the left bar, and GitHub repos are
 * connected on the Integrations panel (foundation contract: /api/folders and
 * /api/integrations/github/repos).
 *
 *   - folders keep existing project content: same ids, agents, subfolders and
 *     navigation after a rename (PATCH /api/folders/:id) and across a reload
 *   - creating a folder POSTs /api/folders with { name } only: never a repo
 *   - folder settings show the connected repo read-only and link to Integrations
 *   - the GitHub Repos section lists the auto-imported Rose repo without a
 *     reconnect, connects a repo with an optional folder, and disconnects
 *   - a connect survives a refresh (the server list is the source of truth) and
 *     the folder's settings show the new repo
 *   - refusals are inline: 403 access denied, 409 folder conflict, 400 invalid,
 *     503 rate limited; nothing is added
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import Integrations from '@/pages/Integrations';
import { useRoseApps } from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { RoseMobileAgentList } from '@/features/terminal-component-group/components/rose-sidebar/RoseMobileAgentList';
import type { GithubRepo } from '@/features/integrations/api/githubRepos';

import { makeAgent, mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';
import { makeProject, mockProjectsApi, type MockProjectsApi } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';
const ROSE_URL = 'https://github.com/Rose-Ai-Labs/rose';

function requests(method: string, path: string) {
  return capturedRequests.filter(
    (r) => r.method === method && new URL(r.url).pathname === `/api${path}`,
  );
}

function repo(overrides: Partial<GithubRepo>): GithubRepo {
  return {
    canonical_ref: 'gh:rose-ai-labs/rose',
    repo_name: 'rose',
    repo_url: ROSE_URL,
    owner: 'rose-ai-labs',
    default_branch: 'main',
    connected_rose_project_ref: 'p-rose',
    integration_id: 'int-rose',
    source: 'legacy_project',
    connected_at: '2026-11-12T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Stateful GitHub repo backend over the folders mock: the Rose repo is already
 * connected (auto-imported from its project). A connect with a folder sets that
 * folder's repo, as the server does for a folder without one.
 */
function githubReposBackend(folders: MockProjectsApi) {
  const repos: GithubRepo[] = [repo({})];
  server.use(
    http.get(`${API_BASE}/integrations/github/repos`, () => HttpResponse.json({ repos })),
    http.post(`${API_BASE}/integrations/github/repos`, async ({ request }) => {
      const body = (await request.json()) as {
        repo_url: string;
        connected_rose_project_ref?: string | null;
      };
      const match = /github\.com\/([^/]+)\/([^/.]+)/i.exec(body.repo_url);
      if (match === null)
        return HttpResponse.json(
          { error: 'INVALID_GITHUB_REPO', message: 'Not a GitHub repository' },
          { status: 400 },
        );
      const [, owner, name] = match;
      if (owner === 'private-org')
        return HttpResponse.json(
          { error: 'GITHUB_ACCESS_DENIED', message: 'Access denied' },
          { status: 403 },
        );
      if (owner === 'busy-org')
        return HttpResponse.json(
          { error: 'GITHUB_RATE_LIMITED', message: 'GitHub rate limit reached' },
          { status: 503, headers: { 'Retry-After': '120' } },
        );
      const folder = folders.projects.find((p) => p.id === body.connected_rose_project_ref);
      if (
        folder?.repoUrl != null &&
        !folder.repoUrl.toLowerCase().includes(`/${owner}/${name}`.toLowerCase())
      )
        return HttpResponse.json(
          { error: 'PROJECT_HAS_OTHER_REPO', message: 'Already connected' },
          { status: 409 },
        );
      if (folder !== undefined && folder.repoUrl === null) {
        folder.repoUrl = body.repo_url;
        folder.githubConnected = true;
      }
      const connected = repo({
        canonical_ref: `gh:${owner}/${name}`.toLowerCase(),
        repo_name: name,
        repo_url: body.repo_url,
        owner: owner.toLowerCase(),
        connected_rose_project_ref: folder?.id ?? null,
        integration_id: `int-${name}`,
        source: 'connect',
      });
      repos.push(connected);
      return HttpResponse.json(connected, { status: 201 });
    }),
    http.delete(`${API_BASE}/integrations/github/repos/:ref`, ({ params }) => {
      const ref = decodeURIComponent(String(params.ref));
      const index = repos.findIndex((r) => r.canonical_ref === ref);
      if (index < 0)
        return HttpResponse.json(
          { error: 'GITHUB_REPO_NOT_CONNECTED', message: 'Repo not connected' },
          { status: 404 },
        );
      repos.splice(index, 1);
      return HttpResponse.json({ disconnected: true, canonical_ref: ref });
    }),
  );
  return repos;
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

function OpenAppProbe() {
  return <span data-testid="open-app">{useRoseApps()?.openApp ?? 'none'}</span>;
}

function sidebar() {
  return (
    <>
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
      <OpenAppProbe />
    </>
  );
}

function roseFolder() {
  return makeProject({ folders: [{ id: 'f-ui', name: 'Interface', projectId: 'p-rose' }] });
}

function websiteFolder() {
  return makeProject({ id: 'p-site', name: 'Website', repoUrl: null, githubConnected: false });
}

beforeEach(() => {
  localStorage.clear();
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

  it('folder settings show the repo read-only and link to the Integrations panel', async () => {
    mockProjectsApi([roseFolder(), websiteFolder()]);
    const user = userEvent.setup();
    renderWithProviders(sidebar());
    await user.click(await screen.findByRole('button', { name: 'Website folder settings' }));
    const section = screen.getByRole('region', { name: 'GitHub repo' });
    await waitFor(() => expect(requests('GET', '/folders').length).toBeGreaterThan(0));
    expect(within(section).getByTestId('folder-github-repo')).toHaveTextContent('No repository');
    expect(within(section).queryByRole('textbox', { name: 'Repository URL' })).toBeNull();
    expect(screen.getByTestId('open-app')).toHaveTextContent('none');
    await user.click(within(section).getByRole('button', { name: 'Connect in Integrations' }));
    expect(screen.getByTestId('open-app')).toHaveTextContent('integrations');
  });
});

describe('GitHub Repos on the Integrations panel', () => {
  it('lists the auto-imported Rose repo without a reconnect, with its folder', async () => {
    const folders = mockProjectsApi([roseFolder()]);
    githubReposBackend(folders);
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const section = await screen.findByRole('region', { name: 'GitHub Repos' });
    const list = await within(section).findByRole('list', { name: 'Connected GitHub repos' });
    expect(within(list).getByText('rose-ai-labs/rose')).toBeVisible();
    await waitFor(() => expect(list).toHaveTextContent('Folder: Rose'));
    expect(list).toHaveTextContent('imported from a project');
    expect(requests('POST', '/integrations/github/repos')).toHaveLength(0);
  });

  it('connects a repo to a folder, keeps it after a refresh, and the folder settings show it', async () => {
    const folders = mockProjectsApi([roseFolder(), websiteFolder()]);
    const repos = githubReposBackend(folders);
    const user = userEvent.setup();
    const view = renderWithProviders(<Integrations />, { roseDesktop: false });
    const section = await screen.findByRole('region', { name: 'GitHub Repos' });
    await user.type(
      within(section).getByRole('textbox', { name: 'GitHub repository URL' }),
      'https://github.com/acme/website',
    );
    const picker = within(section).getByRole('combobox', { name: 'Folder (optional)' });
    await waitFor(() =>
      expect(within(picker).getByRole('option', { name: 'Website' })).toBeTruthy(),
    );
    await user.selectOptions(picker, 'p-site');
    await user.click(within(section).getByRole('button', { name: 'Connect GitHub repo' }));

    await waitFor(() => expect(requests('POST', '/integrations/github/repos')).toHaveLength(1));
    expect(requests('POST', '/integrations/github/repos')[0].body).toEqual({
      repo_url: 'https://github.com/acme/website',
      connected_rose_project_ref: 'p-site',
    });
    const list = within(section).getByRole('list', { name: 'Connected GitHub repos' });
    await waitFor(() => expect(list).toHaveTextContent('acme/website'));
    expect(list).toHaveTextContent('Folder: Website');
    expect(within(section).getByRole('textbox', { name: 'GitHub repository URL' })).toHaveValue('');
    expect(within(section).queryByRole('alert')).toBeNull();
    expect(repos).toHaveLength(2);

    // Refresh: the server's list still has both repos.
    view.unmount();
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const again = await screen.findByRole('list', { name: 'Connected GitHub repos' });
    await waitFor(() => expect(again).toHaveTextContent('acme/website'));
    expect(again).toHaveTextContent('rose-ai-labs/rose');

    // The folder's settings read the new repo from GET /api/folders.
    renderWithProviders(sidebar());
    await user.click(await screen.findByRole('button', { name: 'Website folder settings' }));
    await waitFor(() =>
      expect(screen.getByTestId('folder-github-repo')).toHaveTextContent('gh:acme/website'),
    );
    expect(screen.getByRole('button', { name: 'Change in Integrations' })).toBeVisible();
  });

  it('disconnects a repo from its row', async () => {
    const folders = mockProjectsApi([roseFolder()]);
    const repos = githubReposBackend(folders);
    const user = userEvent.setup();
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const list = await screen.findByRole('list', { name: 'Connected GitHub repos' });
    await user.click(within(list).getByRole('button', { name: 'Disconnect rose-ai-labs/rose' }));
    await waitFor(() => expect(repos).toHaveLength(0));
    expect(requests('DELETE', '/integrations/github/repos/gh%3Arose-ai-labs%2Frose')).toHaveLength(
      1,
    );
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Connected GitHub repos' })).toBeNull(),
    );
  });

  it.each([
    [
      '403 access denied',
      'https://github.com/private-org/secret',
      null,
      /cannot access this repository/,
    ],
    [
      '409 folder already has another repo',
      'https://github.com/acme/other',
      'p-rose',
      /already connected to a different repository/,
    ],
    [
      '400 not a GitHub repo',
      'https://gitlab.com/acme/site',
      null,
      /Enter a GitHub repository URL/,
    ],
    ['503 rate limited', 'https://github.com/busy-org/site', null, /rate limiting.*2 minutes/],
  ])('shows %s inline and adds nothing', async (_label, url, folderId, message) => {
    const folders = mockProjectsApi([roseFolder()]);
    const repos = githubReposBackend(folders);
    const user = userEvent.setup();
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const section = await screen.findByRole('region', { name: 'GitHub Repos' });
    const input = within(section).getByRole('textbox', { name: 'GitHub repository URL' });
    await user.type(input, url);
    if (folderId !== null) {
      const picker = within(section).getByRole('combobox', { name: 'Folder (optional)' });
      await waitFor(() =>
        expect(within(picker).getByRole('option', { name: 'Rose' })).toBeTruthy(),
      );
      await user.selectOptions(picker, folderId);
    }
    await user.click(within(section).getByRole('button', { name: 'Connect GitHub repo' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(message);
    expect(input).toHaveValue(url);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(repos).toHaveLength(1);
    // Editing the URL clears the error.
    await user.type(input, 'x');
    expect(within(section).queryByRole('alert')).toBeNull();
  });

  it('shows the section in the Rose Desktop list too', async () => {
    const folders = mockProjectsApi([roseFolder()]);
    githubReposBackend(folders);
    renderWithProviders(<Integrations />);
    const desktop = await screen.findByTestId('rose-desktop-integrations');
    const section = await within(desktop).findByRole('region', { name: 'GitHub Repos' });
    expect(await within(section).findByText('rose-ai-labs/rose')).toBeVisible();
  });
});
