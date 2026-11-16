/**
 * Blackbox tests for project settings → "Sync from your computer": no
 * copy-paste. In the Rose Mac app, Choose folder… opens the native picker, the
 * app runs the signed-in local agent read-only (`rose import scan`) with a login
 * code bound to THIS project (POST /api/projects/cli-login-codes { projectId }),
 * shows the plan for approval and applies it to this project. Outside the Mac
 * app the section links Download for Mac and mints nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import RoseProjectSettingsPanel from '@/features/terminal-component-group/components/rose-sidebar/RoseProjectSettingsPanel';

import { mockSession } from './app-sidebar.fixtures';
import {
  PICKED_FOLDER,
  installImportBridge,
  makePlan,
  removeImportBridge,
} from './local-import.fixtures';
import { server } from './msw/server';
import { makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';
const CODE = `rlc_${'b'.repeat(32)}`;

function mockMint() {
  const bodies: unknown[] = [];
  server.use(
    http.post(`${API_BASE}/projects/cli-login-codes`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(
        {
          code: CODE,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          project: { id: 'p-rose', name: 'Rose' },
        },
        { status: 201 },
      );
    }),
  );
  return bodies;
}

function renderPanel() {
  const project = makeProject();
  mockProjectsApi([project]);
  renderWithProviders(<RoseProjectSettingsPanel project={project} />);
  return screen.getByRole('region', { name: 'Sync from your computer' });
}

beforeEach(() => {
  localStorage.clear();
  mockSession();
});
afterEach(() => removeImportBridge());

describe('Sync from your computer', () => {
  it('picks the folder, scans with a code bound to this project and syncs the approved plan', async () => {
    const mints = mockMint();
    const fake = installImportBridge({
      plan: makePlan({ projectName: 'Rose' }),
      project: { id: 'p-rose', name: 'Rose' },
    });
    const user = userEvent.setup();
    const section = renderPanel();
    expect(section).toHaveTextContent('Rose reads it with Codex or Claude Code');
    await user.click(within(section).getByRole('button', { name: 'Choose folder…' }));
    const review = await within(section).findByTestId('local-import-review');
    expect(review).toHaveTextContent('Codex read acme-api.');
    expect(mints).toEqual([{ projectId: 'p-rose' }]);
    expect(fake.requests[1]).toMatchObject({
      action: 'scan',
      folder: PICKED_FOLDER,
      loginCode: CODE,
      project: 'p-rose',
    });
    await user.click(within(review).getByRole('button', { name: 'Import' }));
    expect(await within(section).findByText('Rose is ready')).toBeVisible();
    expect(fake.requests[2]).toMatchObject({ action: 'apply', folder: PICKED_FOLDER });
    // Nothing to copy or paste anywhere.
    expect(section).not.toHaveTextContent(/agent-init|npm i|Copy prompt/);
  });

  it('Cancel stops the sync while the local agent is reading', async () => {
    mockMint();
    const fake = installImportBridge({ holdScan: true });
    const user = userEvent.setup();
    const section = renderPanel();
    await user.click(within(section).getByRole('button', { name: 'Choose folder…' }));
    expect(await within(section).findByText('Reading acme-api with Codex…')).toBeVisible();
    await user.click(within(section).getByRole('button', { name: 'Cancel' }));
    expect(fake.bridge.cancelImport).toHaveBeenCalledWith('run-2');
    expect(within(section).getByRole('button', { name: 'Choose folder…' })).toBeVisible();
  });

  it('outside the Mac app it links Download for Mac and mints nothing', async () => {
    const mints = mockMint();
    // A mint starts its POST synchronously, so the fetch calls show it without waiting.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const section = renderPanel();
    expect(within(section).getByRole('link', { name: 'Download for Mac' })).toHaveAttribute(
      'href',
      '/download',
    );
    expect(section).toHaveTextContent('Open the Rose Mac app to sync');
    expect(within(section).queryByRole('button', { name: 'Choose folder…' })).toBeNull();
    await act(async () => {});
    const minting = fetchSpy.mock.calls.filter(([input]) =>
      String(input).includes('cli-login-codes'),
    );
    expect(minting).toEqual([]);
    expect(mints).toEqual([]);
    fetchSpy.mockRestore();
  });
});
