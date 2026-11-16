/**
 * Blackbox tests: Integrations › GitHub Repositories (projects and GitHub repos
 * are one thing; plan docs/plans/completed/projects-are-repos.md, P1 + P2).
 *
 *   - every repository is one integration row: name + "owner/repo · branch · N
 *     env files · synced …", or "From your computer" with no GitHub repo; no
 *     section blurb, folder pickers, switch form or source badges; left-bar
 *     folders (isRepository false) are not listed
 *   - a repository a teammate shared reads "Shared by <owner> · …" and has no ⚙
 *   - Import from your computer needs the Rose Mac app (window.api.roseCli
 *     import bridge): outside it the row says Desktop only + Download for Mac;
 *     in it Import opens the native folder picker, the app finds the signed-in
 *     local agent (Codex first), scans read-only with an UNBOUND login code
 *     (POST /api/projects/cli-login-codes with {}), shows the plan (variable
 *     NAMES only) for approval, applies it, and the list refetches; nothing to
 *     copy or paste and no GitHub checkbox: the Mac's GitHub login (gh) is used by
 *     default whenever there is one. No agent signed in, a scan error and Cancel
 *     are handled.
 *   - GitHub repo: Connect POSTs { repo_url } only and the repo is listed; a
 *     refusal is inline and adds nothing
 *   - ⚙ opens the project-settings slot for that repository; Remove repository
 *     asks first, then DELETE /api/projects/:id removes the row
 *   - the Integrations page shows the section (search "env" finds it) and no
 *     longer has the old GitHub Repos card
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import ProjectsSection from '@/features/integrations/components/ProjectsSection';
import Integrations from '@/pages/Integrations';

import { mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import {
  PICKED_FOLDER,
  installImportBridge,
  makePlan,
  removeImportBridge,
} from './local-import.fixtures';
import { server } from './msw/server';
import { makeProject, mockProjectsApi, type MockProjectsApi } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';

function codeFor(n: number): string {
  return `rlc_${String(n).padStart(32, 'u')}`;
}

/** Unbound mints: each returns the next code and records the request body. */
function mockMint() {
  const bodies: unknown[] = [];
  server.use(
    http.post(`${API_BASE}/projects/cli-login-codes`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(
        {
          code: codeFor(bodies.length),
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          project: null,
        },
        { status: 201 },
      );
    }),
  );
  return bodies;
}

/** POST /integrations/github/repos: the backend links or creates the repo's project. */
function mockConnect(api: MockProjectsApi) {
  const bodies: unknown[] = [];
  server.use(
    http.post(`${API_BASE}/integrations/github/repos`, async ({ request }) => {
      const body = (await request.json()) as { repo_url: string };
      bodies.push(body);
      const match = /github\.com\/([^/]+)\/([^/.]+)/i.exec(body.repo_url);
      if (match === null)
        return HttpResponse.json(
          { error: 'INVALID_GITHUB_REPO', message: 'Not a GitHub repository' },
          { status: 400 },
        );
      if (match[1] === 'private-org')
        return HttpResponse.json(
          { error: 'GITHUB_ACCESS_DENIED', message: 'Access denied' },
          { status: 403 },
        );
      api.projects.push(
        makeProject({
          id: `p-${match[2]}`,
          name: match[2],
          repoUrl: body.repo_url,
          sync: { revision: 0, lastSyncedAt: null },
        }),
      );
      return HttpResponse.json(
        {
          canonical_ref: `gh:${match[1]}/${match[2]}`.toLowerCase(),
          repo_name: match[2],
          repo_url: body.repo_url,
          owner: match[1].toLowerCase(),
          default_branch: 'main',
          connected_rose_project_ref: `p-${match[2]}`,
          integration_id: 'int-gh',
          source: 'connect',
          connected_at: '2026-11-15T00:00:00.000Z',
        },
        { status: 201 },
      );
    }),
  );
  return bodies;
}

function projects() {
  return [
    makeProject({
      sync: { revision: 3, lastSyncedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() },
    }),
    makeProject({
      id: 'p-notes',
      name: 'pricing-notebooks',
      repoUrl: null,
      githubConnected: false,
      sync: { revision: 2, lastSyncedAt: new Date(Date.now() - 30 * 60_000).toISOString() },
    }),
  ];
}

function envFiles() {
  return {
    'p-rose': ['agents/.env', 'back-end/.env'].map((path, i) => ({
      id: `ef-${i}`,
      path,
      description: null,
      kind: 'env' as const,
      source: 'sync' as const,
      variables: [],
      hasContent: true,
      linkTarget: null,
      sizeBytes: 10,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    })),
  };
}

function renderSection() {
  return renderWithProviders(
    <ProjectsSection
      projectSettings={(project) => (
        <div data-testid="settings-slot">Settings for {project.name}</div>
      )}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  mockSession();
  clearCaptures();
  installImportBridge();
});
afterEach(() => {
  removeImportBridge();
});

describe('Integrations › GitHub Repositories', () => {
  it('lists every repository as one row, GitHub and imported alike, and no folders', async () => {
    mockProjectsApi(
      [
        ...projects(),
        makeProject({ id: 'p-folder', name: 'Website', repoUrl: null, isRepository: false }),
      ],
      envFiles(),
    );
    renderSection();
    const section = screen.getByRole('region', { name: 'GitHub Repositories' });
    const rose = await within(section).findByTestId('project-row-p-rose');
    expect(within(rose).getByText('Rose')).toBeVisible();
    expect(within(rose).getByTestId('project-detail')).toHaveTextContent(
      'Rose-Ai-Labs/rose · main · 2 env files · synced 2h ago',
    );
    const notes = within(section).getByTestId('project-row-p-notes');
    expect(within(notes).getByTestId('project-detail')).toHaveTextContent(
      'From your computer · synced 30m ago',
    );
    // A left-bar folder is not a repository.
    expect(within(section).queryByTestId('project-row-p-folder')).toBeNull();
    // One look for the whole panel: no blurb, selects, switch form or source badges.
    expect(within(section).queryByText(/Code agents start/)).toBeNull();
    expect(within(section).queryByRole('combobox')).toBeNull();
    expect(within(section).queryByText(/folder/i)).toBeNull();
    expect(within(section).queryByText(/connected project|manual/i)).toBeNull();
    expect(
      within(section).getByRole('button', { name: 'Import from your computer' }),
    ).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Connect GitHub repo' })).toBeVisible();
    expect(within(section).getByText(/Pulls in your local dev setup/)).toBeVisible();
  });

  it('outside the Mac app, Import from your computer is desktop-only and links Download for Mac', async () => {
    removeImportBridge();
    mockProjectsApi(projects(), envFiles());
    const mints = mockMint();
    renderSection();
    const section = screen.getByRole('region', { name: 'GitHub Repositories' });
    await within(section).findByTestId('project-row-p-rose');
    expect(within(section).queryByRole('button', { name: 'Import from your computer' })).toBeNull();
    expect(within(section).getByText('Desktop only')).toBeVisible();
    expect(within(section).getByRole('link', { name: 'Download for Mac' })).toHaveAttribute(
      'href',
      '/download',
    );
    // Nothing tells the user to install a CLI, and no login code is minted.
    expect(section).not.toHaveTextContent(/npm i/);
    expect(mints).toEqual([]);
  });

  it('a repository a teammate shared is listed read-only, without settings', async () => {
    mockProjectsApi(
      [
        ...projects(),
        makeProject({
          id: 'p-shared',
          name: 'billing',
          repoUrl: 'https://github.com/acme/billing',
          shared: { ownerName: 'Tamara', teamName: 'Rose Labs' },
        }),
      ],
      envFiles(),
    );
    renderSection();
    const row = await screen.findByTestId('project-row-p-shared');
    expect(within(row).getByTestId('project-detail')).toHaveTextContent(
      'Shared by Tamara · acme/billing · main',
    );
    expect(within(row).queryByRole('button', { name: 'billing settings' })).toBeNull();
  });

  it('Import opens the folder picker, reads it with the local agent, and imports the approved plan', async () => {
    const api = mockProjectsApi(projects(), envFiles());
    const mints = mockMint();
    const fake = installImportBridge({
      onApplied: () =>
        api.projects.push(
          makeProject({
            id: 'p-acme',
            name: 'acme-api',
            repoUrl: 'https://github.com/acme/acme-api',
          }),
        ),
    });
    const user = userEvent.setup();
    renderSection();
    await screen.findByTestId('project-row-p-rose');
    await user.click(screen.getByRole('button', { name: 'Import from your computer' }));
    expect(fake.bridge.pickProjectFolder).toHaveBeenCalledTimes(1);

    const review = await screen.findByTestId('local-import-review');
    expect(review).toHaveTextContent('Codex read acme-api. Check what Rose will import:');
    expect(within(review).getByRole('list', { name: 'Env files' })).toHaveTextContent(
      '.env · DATABASE_URL, STRIPE_SECRET_KEY',
    );
    expect(within(review).getByRole('list', { name: 'Setup commands' })).toHaveTextContent(
      'npm cinpx prisma generate',
    );
    // This Mac has a GitHub login: used by default, never asked with a checkbox.
    expect(within(review).queryByRole('checkbox')).toBeNull();
    expect(review).toHaveTextContent(
      'acme/acme-api · code agents will use your GitHub login on this Mac',
    );
    // detect, then a read-only scan with an unbound login code; no prompt to copy.
    expect(fake.requests.map((r) => r.action)).toEqual(['detect', 'scan']);
    expect(fake.requests[1]).toMatchObject({
      folder: PICKED_FOLDER,
      agent: 'codex',
      loginCode: codeFor(1),
      apiUrl: 'http://localhost:3001',
    });
    expect(fake.requests[1]).not.toHaveProperty('project');
    expect(mints).toEqual([{}]);
    expect(screen.queryByText(/agent-init --login-code|npm i/)).toBeNull();

    await user.click(within(review).getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('acme-api is ready')).toBeVisible();
    expect(fake.requests[2]).toEqual({
      action: 'apply',
      folder: PICKED_FOLDER,
      plan: makePlan(),
      githubImport: true,
      apiUrl: 'http://localhost:3001',
    });
    expect(await screen.findByTestId('project-row-p-acme')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Import from your computer' })).toBeVisible();
  });

  it('uses the GitHub login on this Mac by default even when Rose cannot reach the repo', async () => {
    mockProjectsApi(projects(), envFiles());
    mockMint();
    const fake = installImportBridge({
      agent: 'claude',
      plan: makePlan({ github: { status: 'unreachable', login: null, canImport: true } }),
    });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Import from your computer' }));
    const review = await screen.findByTestId('local-import-review');
    expect(review).toHaveTextContent('Claude Code read acme-api.');
    expect(review).toHaveTextContent(
      'acme/acme-api · code agents will use your GitHub login on this Mac',
    );
    expect(within(review).queryByRole('checkbox')).toBeNull();
    await user.click(within(review).getByRole('button', { name: 'Import' }));
    await screen.findByText('acme-api is ready');
    expect(fake.requests[1]).toMatchObject({ action: 'scan', agent: 'claude' });
    expect(fake.requests[2]).toMatchObject({ action: 'apply', githubImport: true });
  });

  it('without a GitHub login on this Mac it says how to give Rose access and imports anyway', async () => {
    mockProjectsApi(projects(), envFiles());
    mockMint();
    const fake = installImportBridge({
      plan: makePlan({ github: { status: 'unreachable', login: null, canImport: false } }),
    });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Import from your computer' }));
    const review = await screen.findByTestId('local-import-review');
    expect(review).toHaveTextContent(
      "Rose can't reach it yet: sign in with gh on this Mac, or connect it below",
    );
    expect(within(review).queryByRole('checkbox')).toBeNull();
    await user.click(within(review).getByRole('button', { name: 'Import' }));
    await screen.findByText('acme-api is ready');
    expect(fake.requests[2]).toMatchObject({ action: 'apply', githubImport: false });
  });

  it('says how to sign in when neither Codex nor Claude Code is signed in on this Mac', async () => {
    mockProjectsApi(projects(), envFiles());
    const mints = mockMint();
    const fake = installImportBridge({ agent: null });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Import from your computer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Rose reads your project with Codex or Claude Code on this Mac, and neither is signed in.',
    );
    expect(fake.requests.map((r) => r.action)).toEqual(['detect']);
    expect(mints).toEqual([]);
  });

  it('shows a scan error with Try again, and Cancel stops a running scan', async () => {
    mockProjectsApi(projects(), envFiles());
    mockMint();
    installImportBridge({ scanError: 'Codex could not read this folder' });
    const user = userEvent.setup();
    const view = renderSection();
    await user.click(await screen.findByRole('button', { name: 'Import from your computer' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Codex could not read this folder');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeVisible();
    view.unmount();

    const held = installImportBridge({ holdScan: true });
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Import from your computer' }));
    expect(await screen.findByText('Reading acme-api with Codex…')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    expect(held.bridge.cancelImport).toHaveBeenCalledWith('run-2');
    expect(screen.queryByTestId('local-import')).toBeNull();
    // A late plan from the cancelled run never shows: release() emits synchronously,
    // and act() flushes every React update it could cause.
    await act(async () => held.release());
    expect(screen.queryByTestId('local-import-review')).toBeNull();
  });

  it('shows why the Mac app refused to start an import', async () => {
    mockProjectsApi(projects(), envFiles());
    installImportBridge({ startError: 'An import is already running on this Mac.' });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Import from your computer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An import is already running on this Mac.',
    );
  });

  it('a cancelled folder picker changes nothing', async () => {
    mockProjectsApi(projects(), envFiles());
    const fake = installImportBridge({ pick: { canceled: true } });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Import from your computer' }));
    await waitFor(() => expect(fake.bridge.pickProjectFolder).toHaveBeenCalled());
    expect(fake.requests).toEqual([]);
    expect(screen.queryByTestId('local-import')).toBeNull();
  });

  it('Connect adds a GitHub repo as a project with { repo_url } only; a refusal stays inline', async () => {
    const api = mockProjectsApi(projects(), envFiles());
    const connects = mockConnect(api);
    const user = userEvent.setup();
    renderSection();
    await screen.findByTestId('project-row-p-rose');
    await user.click(screen.getByRole('button', { name: 'Connect GitHub repo' }));
    const form = screen.getByRole('form', { name: 'Connect a GitHub repo' });
    const url = within(form).getByRole('textbox', { name: 'GitHub repository URL' });

    await user.type(url, 'https://github.com/private-org/secret');
    await user.click(within(form).getByRole('button', { name: 'Connect repository' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      "Rose can't reach this repository",
    );
    expect(screen.queryByTestId('project-row-p-secret')).toBeNull();

    await user.clear(url);
    await user.type(url, 'https://github.com/acme/website');
    await user.click(within(form).getByRole('button', { name: 'Connect repository' }));
    const row = await screen.findByTestId('project-row-p-website');
    expect(within(row).getByTestId('project-detail')).toHaveTextContent('acme/website · main');
    expect(connects).toEqual([
      { repo_url: 'https://github.com/private-org/secret' },
      { repo_url: 'https://github.com/acme/website' },
    ]);
    expect(screen.queryByRole('form', { name: 'Connect a GitHub repo' })).toBeNull();
  });

  it('⚙ opens that project’s settings; Remove repository asks first, then deletes it', async () => {
    const api = mockProjectsApi(projects(), envFiles());
    const user = userEvent.setup();
    renderSection();
    const notes = await screen.findByTestId('project-row-p-notes');
    const gear = within(notes).getByRole('button', { name: 'pricing-notebooks settings' });
    expect(gear).toHaveAttribute('aria-expanded', 'false');
    await user.click(gear);
    expect(gear).toHaveAttribute('aria-expanded', 'true');
    expect(within(notes).getByTestId('settings-slot')).toHaveTextContent(
      'Settings for pricing-notebooks',
    );
    expect(screen.getAllByTestId('settings-slot')).toHaveLength(1);

    await user.click(within(notes).getByRole('button', { name: 'Remove repository' }));
    expect(within(notes).getByText(/Remove pricing-notebooks\?/)).toBeVisible();
    await user.click(within(notes).getByRole('button', { name: 'Cancel' }));
    expect(
      capturedRequests.filter((r) => r.method === 'DELETE' && r.url.includes('/projects/')),
    ).toHaveLength(0);

    await user.click(within(notes).getByRole('button', { name: 'Remove repository' }));
    await user.click(within(notes).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('project-row-p-notes')).toBeNull());
    expect(
      capturedRequests.filter((r) => r.method === 'DELETE').map((r) => new URL(r.url).pathname),
    ).toEqual(['/api/projects/p-notes']);
    expect(api.projects.map((p) => p.id)).toEqual(['p-rose']);
  });

  it('shows the GitHub account the import brought; removing it asks first, then deletes it', async () => {
    mockProjectsApi(projects(), envFiles());
    let connected = true;
    const deletes: string[] = [];
    server.use(
      http.get(`${API_BASE}/projects/github-credential`, () =>
        HttpResponse.json(
          connected
            ? { connected: true, login: 'andyprevalsky', scopes: ['repo'], verifiedAt: null }
            : { connected: false, login: null, scopes: [], verifiedAt: null },
        ),
      ),
      http.delete(`${API_BASE}/projects/github-credential`, ({ request }) => {
        deletes.push(new URL(request.url).pathname);
        connected = false;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderSection();
    const account = await screen.findByTestId('github-account');
    expect(account).toHaveTextContent('@andyprevalsky');
    // The token never reaches the page; only the login is shown.
    expect(document.body).not.toHaveTextContent(/gho_|ghp_|token/i);
    await user.click(
      within(account).getByRole('button', { name: 'Remove GitHub account @andyprevalsky' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('GitHub account @andyprevalsky');
    expect(deletes).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.queryByTestId('github-account')).toBeNull());
    expect(deletes).toEqual(['/api/projects/github-credential']);
  });

  it('the Integrations page has the GitHub Repositories section (search "env" finds it)', async () => {
    // The web page (no Mac app bridge: the rest of the panel probes window.api).
    removeImportBridge();
    mockProjectsApi(projects(), envFiles());
    const user = userEvent.setup();
    renderWithProviders(<Integrations />);
    const section = await screen.findByTestId('integrations-projects', undefined, {
      timeout: 5_000,
    });
    expect(await within(section).findByTestId('project-row-p-rose')).toBeVisible();
    expect(section).toHaveAccessibleName('GitHub Repositories');
    expect(screen.queryByRole('region', { name: 'GitHub Repos' })).toBeNull();
    await user.type(screen.getByRole('searchbox'), 'env');
    expect(screen.getByTestId('integrations-projects')).toBeVisible();
  });
});
