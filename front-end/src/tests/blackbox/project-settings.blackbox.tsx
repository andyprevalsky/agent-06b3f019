/**
 * Blackbox tests for project settings (UI ledger rows 19/30/60), opened from a
 * project row's ⚙ in Integrations › Projects (the left bar has no projects
 * since 2026-11-15; plan docs/plans/completed/projects-are-repos.md).
 *
 * Projects API = MSW in-memory mock in rose-sidebar.fixtures.tsx, strict like
 * the server: GET /api/projects -> { projects } · PUT /api/projects/:id (edited
 * subset only) · env files: GET/POST /api/projects/:id/env-files ·
 * DELETE …/env-files/:fileId
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Toaster } from '@/components/ui/toaster';
import ProjectsSection from '@/features/integrations/components/ProjectsSection';
import RoseProjectSettingsPanel from '@/features/terminal-component-group/components/rose-sidebar/RoseProjectSettingsPanel';

import { mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import { makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

/** Integrations › Projects with the real settings panel in its ⚙ slot (as the apps panel wires it). */
function renderBar() {
  renderWithProviders(
    <>
      <ProjectsSection
        projectSettings={(p) => <RoseProjectSettingsPanel key={p.id} project={p} />}
      />
      <Toaster />
    </>,
  );
}

function requests(method: string, path: string) {
  return capturedRequests.filter(
    (r) => r.method === method && new URL(r.url).pathname === `/api${path}`,
  );
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Rose settings' }));
  return screen.getByTestId('project-settings-content');
}

describe('Project settings (Integrations › Projects ⚙)', () => {
  let api: ReturnType<typeof mockProjectsApi>;
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
    api = mockProjectsApi([makeProject()]);
  });
  afterEach(() => localStorage.clear());

  it('⚙ opens the project settings under its row with every section; ⚙ again closes them', async () => {
    const user = userEvent.setup();
    renderBar();
    const panel = await openSettings(user);
    expect(screen.getByTestId('project-row-p-rose')).toContainElement(panel);
    expect(within(panel).getByRole('textbox', { name: 'Project name' })).toHaveValue('Rose');

    const repo = within(panel).getByRole('region', { name: 'Repository' });
    // Read-only: the project's repo (a GitHub repo is a project; connected on this panel).
    expect(within(repo).getByTestId('project-repository')).toHaveTextContent(
      'https://github.com/Rose-Ai-Labs/rose',
    );
    expect(within(repo).queryByRole('textbox', { name: 'Repository URL' })).toBeNull();
    expect(within(repo).queryByRole('button', { name: 'Change' })).toBeNull();
    expect(within(repo).getByRole('textbox', { name: 'Default branch' })).toHaveValue('main');
    expect(within(repo).getByTestId('project-github-status')).toHaveTextContent('Connected');
    expect(within(repo).getByTestId('project-last-synced').querySelector('time')).toHaveAttribute(
      'dateTime',
      '2026-10-20T17:05:00.000Z',
    );

    expect(within(panel).getByRole('textbox', { name: 'Startup script' })).toHaveValue(
      'sudo service postgresql start || true',
    );
    expect(
      within(panel).getByRole('spinbutton', { name: 'Startup timeout (seconds)' }),
    ).toHaveValue(120);

    const env = within(panel).getByRole('region', { name: 'Environment files' });
    expect(env).toHaveTextContent('Environment files · 2');
    expect(await within(env).findAllByTestId('project-env-file')).toHaveLength(2);
    expect(within(env).getByRole('button', { name: '+ Add a file' })).toBeInTheDocument();

    const lifecycle = within(panel).getByRole('region', { name: 'Lifecycle' });
    expect(within(lifecycle).getByRole('button', { name: 'Auto-wake' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(lifecycle).toHaveTextContent('Startup script');
    expect(lifecycle).toHaveTextContent('set');
    // No checkout-import/setup-helper block (Andy, 2026-10-26: "wtf is this part?").
    expect(within(panel).queryByRole('region', { name: 'Development environment' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Download setup helper' })).toBeNull();
    expect(panel).not.toHaveTextContent(
      /Import your working checkout|Not imported yet|Checkout imported/,
    );

    await user.click(screen.getByRole('button', { name: 'Rose settings' }));
    expect(screen.queryByTestId('project-settings-content')).toBeNull();
  });

  it('a project without GitHub reads Imported from your computer, Not connected (never an error), Never synced', async () => {
    const user = userEvent.setup();
    api = mockProjectsApi([
      makeProject({
        repoUrl: null,
        githubConnected: false,
        startupScript: null,
        sync: { revision: 0, lastSyncedAt: null },
      }),
    ]);
    renderBar();
    const panel = await openSettings(user);
    const repo = within(panel).getByRole('region', { name: 'Repository' });
    expect(within(repo).getByTestId('project-github-status')).toHaveTextContent('Not connected');
    expect(within(repo).getByTestId('project-last-synced')).toHaveTextContent('Never');
    expect(within(repo).getByTestId('project-repository')).toHaveTextContent(
      'Imported from your computer',
    );
    expect(within(panel).queryByRole('alert')).toBeNull();
    expect(within(panel).getByRole('textbox', { name: 'Startup script' })).toHaveValue('');
    expect(within(panel).getByRole('region', { name: 'Lifecycle' })).toHaveTextContent('not set');
  });

  it('Environment files load from GET …/env-files; rows expand to variable NAMES only', async () => {
    // The fixture answers with the backend's { envFiles, query } envelope
    // (envFileService.listEnvFiles); reading it as a bare array crashed the
    // whole app on opening project settings (FE-13 visual pass, :3902).
    const user = userEvent.setup();
    renderBar();
    const panel = await openSettings(user);
    const env = within(panel).getByRole('region', { name: 'Environment files' });
    const rows = await within(env).findAllByTestId('project-env-file');
    expect(requests('GET', '/projects/p-rose/env-files')).toHaveLength(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('agents/.env'),
      expect.stringContaining('back-end/.env'),
    ]);
    expect(rows[0]).toHaveTextContent('Agent worker secrets');
    expect(within(env).queryByText('BACKEND_API_KEY')).toBeNull();

    await user.click(within(env).getByRole('button', { name: 'Expand agents/.env' }));
    const vars = within(env).getByRole('list', { name: 'Variables in agents/.env' });
    expect(
      within(vars)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['BACKEND_API_KEY', 'FLY_API_TOKEN · Fly deploys']);
    // Values are never returned, so no value field is rendered.
    expect(within(env).queryByRole('textbox', { name: /value/i })).toBeNull();

    // Search matches path, description or variable name.
    const search = within(env).getByRole('searchbox', { name: 'Search environment files' });
    await user.type(search, 'render_api');
    expect(within(env).getAllByTestId('project-env-file')).toHaveLength(1);
    expect(within(env).getByTestId('project-env-file')).toHaveTextContent('back-end/.env');
    await user.clear(search);
    await user.type(search, 'backend secrets');
    expect(within(env).getAllByTestId('project-env-file')).toHaveLength(1);
  });

  it('trash DELETEs the env file; the header count follows envFileCount', async () => {
    const user = userEvent.setup();
    renderBar();
    const panel = await openSettings(user);
    const env = within(panel).getByRole('region', { name: 'Environment files' });
    await within(env).findAllByTestId('project-env-file');

    await user.click(within(env).getByRole('button', { name: 'Remove back-end/.env' }));
    await waitFor(() =>
      expect(requests('DELETE', '/projects/p-rose/env-files/ef-backend')).toHaveLength(1),
    );
    await waitFor(() => expect(within(env).getAllByTestId('project-env-file')).toHaveLength(1));
    expect(api.envFiles.get('p-rose')?.map((f) => f.path)).toEqual(['agents/.env']);
    await waitFor(() => expect(env).toHaveTextContent('Environment files · 1'));
    expect(requests('PUT', '/projects/p-rose')).toHaveLength(0);
  });

  it('+ Add a file POSTs { path, description?, content? } (dotenv paste) and lists its names', async () => {
    const user = userEvent.setup();
    renderBar();
    const panel = await openSettings(user);
    const env = within(panel).getByRole('region', { name: 'Environment files' });
    await within(env).findAllByTestId('project-env-file');

    await user.click(within(env).getByRole('button', { name: '+ Add a file' }));
    const form = within(env).getByRole('form', { name: 'Add an environment file' });
    const add = within(form).getByRole('button', { name: 'Add file' });
    expect(add).toBeDisabled();
    await user.type(within(form).getByRole('textbox', { name: 'File path' }), 'front-end/.env');
    await user.type(within(form).getByRole('textbox', { name: 'File description' }), 'Vite');
    await user.type(
      within(form).getByRole('textbox', { name: 'Paste .env contents' }),
      'VITE_API_URL=http://localhost:3001{Enter}export VITE_FLAG=1',
    );
    await user.click(add);

    await waitFor(() => expect(requests('POST', '/projects/p-rose/env-files')).toHaveLength(1));
    expect(requests('POST', '/projects/p-rose/env-files')[0].body).toEqual({
      path: 'front-end/.env',
      description: 'Vite',
      content: 'VITE_API_URL=http://localhost:3001\nexport VITE_FLAG=1',
    });
    expect(within(env).queryByRole('form', { name: 'Add an environment file' })).toBeNull();
    await waitFor(() => expect(within(env).getAllByTestId('project-env-file')).toHaveLength(3));
    await waitFor(() => expect(env).toHaveTextContent('Environment files · 3'));
    await user.click(within(env).getByRole('button', { name: 'Expand front-end/.env' }));
    const vars = within(env).getByRole('list', { name: 'Variables in front-end/.env' });
    expect(
      within(vars)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['VITE_API_URL', 'VITE_FLAG']);
    // The pasted values never come back.
    expect(env).not.toHaveTextContent('http://localhost:3001');

    // Path only: optional fields are omitted, not sent empty.
    await user.click(within(env).getByRole('button', { name: '+ Add a file' }));
    const form2 = within(env).getByRole('form', { name: 'Add an environment file' });
    await user.type(within(form2).getByRole('textbox', { name: 'File path' }), 'mac-app/.env');
    await user.click(within(form2).getByRole('button', { name: 'Add file' }));
    await waitFor(() => expect(requests('POST', '/projects/p-rose/env-files')).toHaveLength(2));
    expect(requests('POST', '/projects/p-rose/env-files')[1].body).toEqual({
      path: 'mac-app/.env',
    });
  });

  it('Save PUTs only the edited subset with contract field names', async () => {
    const user = userEvent.setup();
    renderBar();
    const panel = await openSettings(user);
    const save = within(panel).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    const timeout = within(panel).getByRole('spinbutton', { name: 'Startup timeout (seconds)' });
    await user.clear(timeout);
    await user.type(timeout, '300');
    await user.click(within(panel).getByRole('button', { name: 'Auto-wake' }));
    const branch = within(panel).getByRole('textbox', { name: 'Default branch' });
    await user.clear(branch);
    await user.type(branch, 'develop');

    await user.click(save);
    await waitFor(() => expect(requests('PUT', '/projects/p-rose')).toHaveLength(1));
    // Never a repoUrl: a repo is connected as its own project on this panel.
    expect(requests('PUT', '/projects/p-rose')[0].body).toEqual({
      defaultBranch: 'develop',
      startupTimeoutS: 300,
      lifecycle: { autoWake: false },
    });
    expect(requests('PATCH', '/projects/p-rose')).toHaveLength(0);
    await waitFor(() => expect(save).toBeDisabled());
    expect(within(panel).queryByRole('alert')).toBeNull();
    expect(api.projects[0]).toMatchObject({
      startupTimeoutS: 300,
      lifecycle: { autoWake: false },
    });
  });

  it("clearing the startup script sends startupScript '' (clears it)", async () => {
    const user = userEvent.setup();
    renderBar();
    const panel = await openSettings(user);
    await user.clear(within(panel).getByRole('textbox', { name: 'Startup script' }));
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requests('PUT', '/projects/p-rose')).toHaveLength(1));
    expect(requests('PUT', '/projects/p-rose')[0].body).toEqual({ startupScript: '' });
    await waitFor(() => expect(api.projects[0].startupScript).toBeNull());
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(within(panel).getByRole('region', { name: 'Lifecycle' })).toHaveTextContent('not set');
  });

  it('a startup timeout outside 1..3600 cannot be saved', async () => {
    const user = userEvent.setup();
    renderBar();
    const panel = await openSettings(user);
    const timeout = within(panel).getByRole('spinbutton', { name: 'Startup timeout (seconds)' });
    for (const bad of ['0', '3601']) {
      await user.clear(timeout);
      await user.type(timeout, bad);
      expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(within(panel).getByTestId('project-timeout-error')).toHaveTextContent(
        'Use 1–3600 seconds',
      );
    }
    await user.clear(timeout);
    await user.type(timeout, '3600');
    expect(within(panel).queryByTestId('project-timeout-error')).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
