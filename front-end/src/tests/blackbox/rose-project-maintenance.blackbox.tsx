/**
 * Blackbox tests for the Rose project "Template sync" settings (the Rose
 * version of a boxes.dev Template box's maintenance settings): Last snapshot +
 * Snapshot now, the sync script with a timeout up to 8 minutes, Run on a
 * schedule, Run when files change on GitHub, Run now, and Recent runs with logs.
 *
 * The Projects API is the in-memory MSW mock in rose-sidebar.fixtures.tsx
 * (strict like the server: unknown write fields are a 400; POST …/maintenance/runs
 * answers 409 while a run is active). A failed run publishes no snapshot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { Toaster } from '@/components/ui/toaster';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { capturedRequests, clearCaptures } from './msw/capture';
import {
  expandBar,
  makeProject,
  makeRun,
  mockProjectsApi,
  signedInUser,
} from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

function renderBar() {
  const props = defaultProps({
    agents: [makeAgent({ agent_id: 'a-rose', goal: 'Rose UI polish', project_id: 'p-rose' })],
    user: signedInUser(),
  });
  renderWithProviders(
    <>
      <AppSidebar {...props} />
      <Toaster />
    </>,
  );
  expandBar();
}

function requests(method: string, path: string) {
  return capturedRequests.filter(
    (r) => r.method === method && new URL(r.url).pathname === `/api${path}`,
  );
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Rose project settings' }));
  const panel = screen.getByTestId('rose-project-settings');
  return within(await within(panel).findByRole('region', { name: 'Template sync' }));
}

const SYNC_SCRIPT = 'set -euo pipefail\nnpm install\n';

describe('Rose project template sync settings', () => {
  let api: ReturnType<typeof mockProjectsApi>;
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
    api = mockProjectsApi([
      makeProject({
        maintenance: {
          script: SYNC_SCRIPT,
          timeoutS: 480,
          nightly: false,
          onGithubChange: false,
          nextRunAt: null,
          watchCheckedAt: null,
          running: false,
        },
      }),
    ]);
  });
  afterEach(() => localStorage.clear());

  it('shows the boxes-style controls: snapshot, script, 480 s timeout, triggers, Run now, runs', async () => {
    const user = userEvent.setup();
    renderBar();
    const sync = await openSettings(user);
    expect(sync.getByTestId('project-last-snapshot')).toHaveTextContent('None yet');
    expect(sync.getByRole('button', { name: 'Snapshot now' })).toBeEnabled();
    expect(sync.getByRole('textbox', { name: 'Sync script' })).toHaveValue(SYNC_SCRIPT);
    expect(sync.getByRole('spinbutton', { name: 'Sync timeout (seconds)' })).toHaveValue(480);
    expect(sync.getByRole('button', { name: 'Run on a schedule' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(sync.getByRole('button', { name: 'Run when files change on GitHub' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(sync.getByRole('button', { name: 'Run now' })).toBeEnabled();
    expect(await sync.findByText('No runs yet.')).toBeInTheDocument();
  });

  it('saves only the changed sync settings in one maintenance object; a cleared script is null', async () => {
    const user = userEvent.setup();
    renderBar();
    const sync = await openSettings(user);
    const panel = screen.getByTestId('rose-project-settings');
    await user.click(sync.getByRole('button', { name: 'Run on a schedule' }));
    await user.click(sync.getByRole('button', { name: 'Run when files change on GitHub' }));
    const timeout = sync.getByRole('spinbutton', { name: 'Sync timeout (seconds)' });
    await user.clear(timeout);
    await user.type(timeout, '300');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requests('PUT', '/projects/p-rose')).toHaveLength(1));
    expect(requests('PUT', '/projects/p-rose')[0].body).toEqual({
      maintenance: { timeoutS: 300, nightly: true, onGithubChange: true },
    });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(api.projects[0].maintenance).toMatchObject({ timeoutS: 300, nightly: true });

    await user.clear(sync.getByRole('textbox', { name: 'Sync script' }));
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requests('PUT', '/projects/p-rose')).toHaveLength(2));
    expect(requests('PUT', '/projects/p-rose')[1].body).toEqual({ maintenance: { script: null } });
  });

  it('shows the next nightly run and the GitHub last-checked time once the triggers are saved', async () => {
    api.projects[0].maintenance = {
      ...api.projects[0].maintenance,
      nightly: true,
      onGithubChange: true,
      nextRunAt: '2026-10-29T10:00:00.000Z',
    };
    const user = userEvent.setup();
    renderBar();
    const sync = await openSettings(user);
    expect(sync.getByRole('button', { name: 'Run on a schedule' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(sync.getByText(/Nightly · next run/)).toBeInTheDocument();
    expect(await sync.findByText(/main · checked/)).toBeInTheDocument();
  });

  it('a sync timeout above 8 minutes (480 s) cannot be saved', async () => {
    const user = userEvent.setup();
    renderBar();
    const sync = await openSettings(user);
    const panel = screen.getByTestId('rose-project-settings');
    const timeout = sync.getByRole('spinbutton', { name: 'Sync timeout (seconds)' });
    for (const bad of ['0', '481']) {
      await user.clear(timeout);
      await user.type(timeout, bad);
      expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(sync.getByTestId('project-sync-timeout-error')).toHaveTextContent('Use 1–480 seconds');
    }
    await user.clear(timeout);
    await user.type(timeout, '480');
    expect(sync.queryByTestId('project-sync-timeout-error')).toBeNull();
    expect(requests('PUT', '/projects/p-rose')).toHaveLength(0);
  });

  it('Run now and Snapshot now are disabled while edits are unsaved (the server runs the saved script)', async () => {
    const user = userEvent.setup();
    renderBar();
    const sync = await openSettings(user);
    await user.type(sync.getByRole('textbox', { name: 'Sync script' }), '\necho more');
    expect(sync.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(sync.getByRole('button', { name: 'Run now' })).toHaveAttribute(
      'title',
      expect.stringContaining('Save your changes first'),
    );
    expect(sync.getByRole('button', { name: 'Snapshot now' })).toBeDisabled();
    await user.click(
      within(screen.getByTestId('rose-project-settings')).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() => expect(sync.getByRole('button', { name: 'Run now' })).toBeEnabled());
    expect(requests('POST', '/projects/p-rose/maintenance/runs')).toHaveLength(0);
  });

  it('Run now starts a sync, blocks a second one, and a success publishes the snapshot', async () => {
    const user = userEvent.setup();
    renderBar();
    const sync = await openSettings(user);
    await user.click(sync.getByRole('button', { name: 'Run now' }));
    await waitFor(() =>
      expect(requests('POST', '/projects/p-rose/maintenance/runs')).toHaveLength(1),
    );
    expect(requests('POST', '/projects/p-rose/maintenance/runs')[0].body).toEqual({ mode: 'sync' });
    expect(await sync.findByTestId('maintenance-running')).toBeInTheDocument();
    expect(sync.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(sync.getByRole('button', { name: 'Snapshot now' })).toBeDisabled();

    api.maintenance.get('p-rose')?.finish('SUCCEEDED', 'ready at abc1234');
    // The panel polls every 3 s while a sync runs.
    await waitFor(() => expect(sync.queryByTestId('maintenance-running')).toBeNull(), {
      timeout: 8000,
    });
    expect(sync.getByTestId('project-last-snapshot').querySelector('time')).not.toBeNull();
    const rows = await sync.findAllByTestId('maintenance-run');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Succeeded');
    expect(rows[0]).toHaveTextContent('Run now');
    await user.click(within(rows[0]).getByRole('button'));
    expect(await within(rows[0]).findByLabelText('Run log')).toHaveTextContent('ready at abc1234');
    expect(sync.getByRole('button', { name: 'Run now' })).toBeEnabled();
  }, 15_000);

  it('a failed run shows Failed with its log and leaves the previous snapshot in place', async () => {
    api.projects[0].snapshot = { takenAt: '2026-10-27T10:00:00.000Z', sha: null };
    const user = userEvent.setup();
    renderBar();
    const sync = await openSettings(user);
    expect(sync.getByTestId('project-last-snapshot').querySelector('time')).toHaveAttribute(
      'dateTime',
      '2026-10-27T10:00:00.000Z',
    );
    await user.click(sync.getByRole('button', { name: 'Run now' }));
    await sync.findByTestId('maintenance-running');
    api.maintenance.get('p-rose')?.finish('FAILED', 'npm ERR! boom');
    await waitFor(() => expect(sync.queryByTestId('maintenance-running')).toBeNull(), {
      timeout: 8000,
    });
    const row = (await sync.findAllByTestId('maintenance-run'))[0];
    expect(row).toHaveTextContent('Failed');
    await user.click(within(row).getByRole('button'));
    expect(await within(row).findByLabelText('Run log')).toHaveTextContent('npm ERR! boom');
    // No snapshot was published by the failed run.
    expect(sync.getByTestId('project-last-snapshot').querySelector('time')).toHaveAttribute(
      'dateTime',
      '2026-10-27T10:00:00.000Z',
    );
  }, 15_000);

  it('Snapshot now posts mode snapshot and needs no sync script', async () => {
    api.projects[0].maintenance = { ...api.projects[0].maintenance, script: null };
    const user = userEvent.setup();
    renderBar();
    const sync = await openSettings(user);
    expect(sync.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(sync.getByRole('button', { name: 'Run now' })).toHaveAttribute(
      'title',
      expect.stringContaining('Add a sync script'),
    );
    await user.click(sync.getByRole('button', { name: 'Snapshot now' }));
    await waitFor(() =>
      expect(requests('POST', '/projects/p-rose/maintenance/runs')).toHaveLength(1),
    );
    expect(requests('POST', '/projects/p-rose/maintenance/runs')[0].body).toEqual({
      mode: 'snapshot',
    });
  });

  it('a project without a repository cannot run a sync', async () => {
    api.projects[0].repoUrl = null;
    const user = userEvent.setup();
    renderBar();
    const sync = await openSettings(user);
    expect(sync.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(sync.getByRole('button', { name: 'Run now' })).toHaveAttribute(
      'title',
      expect.stringContaining('Set a code repository first'),
    );
  });

  it('lists recent runs with status and trigger, newest first', async () => {
    api.maintenanceOf('p-rose').state.runs = [
      makeRun({ id: 'r2', trigger: 'nightly', status: 'FAILED', error: 'exit 1' }),
      makeRun({ id: 'r1', trigger: 'github', status: 'SUCCEEDED' }),
    ];
    const user = userEvent.setup();
    renderBar();
    const sync = await openSettings(user);
    const rows = await sync.findAllByTestId('maintenance-run');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Failed');
    expect(rows[0]).toHaveTextContent('Nightly');
    expect(rows[1]).toHaveTextContent('Succeeded');
    expect(rows[1]).toHaveTextContent('GitHub change');
  });

  it('every light surface in the section has a dark-mode variant', async () => {
    const user = userEvent.setup();
    renderBar();
    const sync = await openSettings(user);
    const section = screen.getByRole('region', { name: 'Template sync' });
    for (const element of section.querySelectorAll('[class]')) {
      const classes = element.getAttribute('class') ?? '';
      if (/(^|\s)bg-\[#/.test(classes)) expect(classes).toMatch(/dark:bg-\[#/);
      if (/(^|\s)border-\[#/.test(classes)) expect(classes).toMatch(/dark:border-/);
      if (/(^|\s)text-slate-/.test(classes)) expect(classes).toMatch(/dark:text-\[#/);
    }
    expect(section.querySelectorAll('[class*="bg-white"]')).toHaveLength(0);
  });
});
