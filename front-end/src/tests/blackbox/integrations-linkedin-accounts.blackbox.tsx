/**
 * LinkedIn accounts on Rose Desktop (plan row I4), on the real backend contract
 * (back-end/src/domains/integrations/linkedinSyncContract.ts, routes.linkedin.ts):
 *
 *   accountsByProvider.linkedin[]  one chip per account ('default' = the old single account)
 *   progress.phase                 starting → export_requested → waiting_for_export
 *                                  (eta only when LinkedIn stated one) → uploading
 *                                  (bytes, as sizes) → parsing (records) → synced | failed
 *   config.linkedinSync.phases[]   the timeline; shown while the live report is blank
 *   POST /linkedin/sync {agent_id, account_id?}   409 = that account already exports
 *   DELETE /linkedin/accounts/:accountId
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import {
  createLinkedInSyncAgentApi,
  LinkedInExportRunningError,
} from '@/features/integrations/api/linkedin';
import { linkedinRunProgress } from '@/features/integrations/components/desktopLinkedIn';
import { formatBytes, phaseLabel } from '@/features/integrations/components/syncProgressFormat';

import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import {
  API_BASE,
  account,
  chipFor,
  progress,
  renderIntegrations,
  row,
  rowEl,
  serveList,
} from './integrations-accounts.fixtures';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

type Extra = Record<string, unknown>;

/** One Integration row per LinkedIn account (storage id '' = default). */
function linkedinList(accounts: Array<{ id: string; wire: Extra; config?: Extra }>) {
  const wire = accounts.map(({ id, wire: extra }) => account('linkedin', id, extra));
  return {
    integrations: accounts.map(({ id, config }) =>
      row('linkedin', wire, {
        accountId: id === 'default' ? '' : id,
        status: 'CONNECTED',
        config: config ?? {},
      }),
    ),
    accountsByProvider: { linkedin: wire },
  };
}

const syncingAt = (phase: string, extra: Extra = {}) => ({
  state: 'syncing',
  progress: progress({ phase, ...extra }),
});

const bar = () => within(rowEl('linkedin')).getByTestId('sync-progress');

describe('LinkedIn I4: accounts and export phases on Rose Desktop', () => {
  beforeEach(() => mockSession());
  afterEach(() => localStorage.clear());

  it('one chip per account: the imported name, else the profile id', async () => {
    serveList(() =>
      linkedinList([
        { id: 'default', wire: {}, config: { profile: { firstName: 'Andy', lastName: 'P' } } },
        { id: 'jane-doe', wire: syncingAt('starting') },
      ]),
    );
    renderIntegrations();
    await waitFor(() =>
      expect(chipFor('linkedin', 'Andy P')).toHaveAttribute('data-tone', 'synced'),
    );
    expect(chipFor('linkedin', 'jane-doe')).toHaveAttribute('data-tone', 'syncing');
    expect(bar()).toHaveTextContent('jane-doe · Starting export · Syncing…');
    expect(screen.queryByText('default')).toBeNull();
  });

  it('waiting_for_export shows the ETA only when LinkedIn stated one', async () => {
    let eta: number | null = 3600;
    serveList(() =>
      linkedinList([{ id: 'jane-doe', wire: syncingAt('waiting_for_export', { eta_sec: eta }) }]),
    );
    const view = renderIntegrations();
    await waitFor(() =>
      expect(bar()).toHaveTextContent('Waiting for LinkedIn to prepare the export'),
    );
    expect(bar()).toHaveAttribute('data-state', 'indeterminate');
    expect(bar()).toHaveTextContent('~1 h left');

    view.unmount();
    eta = null;
    renderIntegrations();
    await waitFor(() =>
      expect(bar()).toHaveTextContent('Waiting for LinkedIn to prepare the export'),
    );
    expect(bar()).not.toHaveTextContent('left');
  });

  it('uploading reads sizes, parsing reads records', async () => {
    let phase = 'uploading';
    serveList(() =>
      linkedinList([
        {
          id: 'jane-doe',
          wire:
            phase === 'uploading'
              ? syncingAt('uploading', { done: 3_000_000, total: 12_000_000, unit: 'bytes' })
              : syncingAt('parsing', { done: 120, total: 480, unit: 'records' }),
        },
      ]),
    );
    const view = renderIntegrations();
    await waitFor(() => expect(bar()).toHaveTextContent('Uploading archive · 3 MB of 12 MB'));
    expect(within(bar()).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    expect(bar()).not.toHaveTextContent('3,000,000');

    view.unmount();
    phase = 'parsing';
    renderIntegrations();
    await waitFor(() => expect(bar()).toHaveTextContent('Reading archive · 120 of 480 records'));
  });

  it('a blank live report falls back to the run timeline in config.linkedinSync', async () => {
    serveList(() =>
      linkedinList([
        {
          id: 'jane-doe',
          wire: { state: 'syncing', progress: progress() },
          config: {
            linkedinSync: {
              runId: 'li-agent-a1',
              phase: 'export_requested',
              readyBy: null,
              phases: [
                { phase: 'starting', at: '2026-10-20T10:00:00Z' },
                { phase: 'export_requested', at: '2026-10-20T10:02:00Z' },
              ],
            },
          },
        },
      ]),
    );
    renderIntegrations();
    await waitFor(() => expect(bar()).toHaveTextContent('Export requested'));
  });

  it('failed: lastError is printed under the chips and retry re-exports that account', async () => {
    serveList(() =>
      linkedinList([
        {
          id: 'jane-doe',
          wire: { state: 'failed', lastError: 'The download link expired' },
        },
      ]),
    );
    const synced: unknown[] = [];
    server.use(
      http.post(`${API_BASE}/integrations/linkedin/sync`, async ({ request }) => {
        synced.push(await request.json());
        return HttpResponse.json({ status: 'SYNCING', phase: 'starting' });
      }),
    );
    const user = userEvent.setup();
    renderIntegrations();
    const error = await within(await waitFor(() => rowEl('linkedin'))).findByTestId(
      'account-sync-error',
    );
    expect(error).toHaveTextContent('The download link expired');
    expect(chipFor('linkedin', 'jane-doe')).toHaveAttribute('data-tone', 'error');
    expect(chipFor('linkedin', 'jane-doe')).toHaveTextContent('sync failed');
    await user.click(screen.getByRole('button', { name: 'Retry LinkedIn export for jane-doe' }));
    await waitFor(() => expect(synced).toHaveLength(1));
    expect(synced[0]).toEqual({ agent_id: 'new-agent-001', account_id: 'jane-doe' });
    expect(await screen.findByText('Agent spawned')).toBeInTheDocument();
  });

  it('removes one account through DELETE /linkedin/accounts/:accountId', async () => {
    serveList(() =>
      linkedinList([
        { id: 'default', wire: {} },
        { id: 'jane-doe', wire: {} },
      ]),
    );
    const deleted: string[] = [];
    server.use(
      http.delete(`${API_BASE}/integrations/linkedin/accounts/:accountId`, ({ params }) => {
        deleted.push(String(params.accountId));
        return HttpResponse.json({
          deleted: { provider: 'linkedin', accountId: params.accountId },
        });
      }),
    );
    const user = userEvent.setup();
    renderIntegrations();
    await user.click(
      await screen.findByRole('button', { name: 'Remove LinkedIn account LinkedIn account' }),
    );
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(deleted).toEqual(['default']));
    await user.click(screen.getByRole('button', { name: 'Remove LinkedIn account jane-doe' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(deleted).toEqual(['default', 'jane-doe']));
  });

  it('409 on + Add account: toast, the duplicate agent is deleted, no error', async () => {
    serveList(() => linkedinList([{ id: 'jane-doe', wire: {} }]));
    const deletedAgents: string[] = [];
    server.use(
      http.post(`${API_BASE}/integrations/linkedin/sync`, () =>
        HttpResponse.json(
          { error: 'A LinkedIn export is already running', agent_id: 'a-live' },
          {
            status: 409,
          },
        ),
      ),
      http.delete(`${API_BASE}/agents/:agentId`, ({ params }) => {
        deletedAgents.push(String(params.agentId));
        return HttpResponse.json({ success: true });
      }),
    );
    const user = userEvent.setup();
    renderIntegrations();
    await user.click(await screen.findByRole('button', { name: 'Add LinkedIn account' }));
    expect(await screen.findByText('LinkedIn export already running')).toBeInTheDocument();
    await waitFor(() => expect(deletedAgents).toEqual(['new-agent-001']));
    expect(screen.queryByRole('alert')).toBeNull();
    const record = capturedRequests.find((r) => r.url.endsWith('/integrations/linkedin/sync'));
    expect(record?.body).toEqual({ agent_id: 'new-agent-001' });
  });

  it('+ Add account while the default account is exporting spawns no agent', async () => {
    serveList(() => linkedinList([{ id: 'default', wire: syncingAt('waiting_for_export') }]));
    const user = userEvent.setup();
    renderIntegrations();
    await user.click(await screen.findByRole('button', { name: 'Add LinkedIn account' }));
    expect(await screen.findByText('LinkedIn export already running')).toBeInTheDocument();
    expect(capturedRequests.some((r) => r.method === 'POST' && r.url.endsWith('/api/agents'))).toBe(
      false,
    );
  });

  it('flag off: the stock LinkedIn row shows no per-account chips', async () => {
    serveList(() =>
      linkedinList([
        { id: 'default', wire: {} },
        { id: 'jane-doe', wire: syncingAt('waiting_for_export', { eta_sec: 60 }) },
      ]),
    );
    renderIntegrations({ roseDesktop: false });
    expect(await screen.findByText('Enable web automation and browsing')).toBeInTheDocument();
    expect(screen.queryByText('jane-doe')).toBeNull();
    expect(screen.queryByText(/Waiting for LinkedIn/)).toBeNull();
  });
});

describe('LinkedIn I4: API and formatting', () => {
  beforeEach(() => mockSession());
  afterEach(() => localStorage.clear());

  it('createLinkedInSyncAgentApi sends account_id and types a 409', async () => {
    server.use(
      http.post(`${API_BASE}/integrations/linkedin/sync`, () =>
        HttpResponse.json({ error: 'busy', agent_id: 'a-live' }, { status: 409 }),
      ),
    );
    const failure = await createLinkedInSyncAgentApi('jane-doe').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LinkedInExportRunningError);
    expect(failure).toMatchObject({
      message: 'busy',
      runningAgentId: 'a-live',
      spawnedAgentId: 'new-agent-001',
    });
    const record = capturedRequests.find((r) => r.url.endsWith('/integrations/linkedin/sync'));
    expect(record?.body).toEqual({ agent_id: 'new-agent-001', account_id: 'jane-doe' });
  });

  it('a non-409 failure stays a plain error', async () => {
    server.use(
      http.post(`${API_BASE}/integrations/linkedin/sync`, () =>
        HttpResponse.json({ error: 'Agent not found' }, { status: 404 }),
      ),
    );
    const failure = await createLinkedInSyncAgentApi().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(LinkedInExportRunningError);
    expect((failure as Error).message).toBe('Agent not found');
  });

  it('formats bytes and phases; the timeline ETA comes from readyBy', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(12_000_000)).toBe('12 MB');
    expect(formatBytes(999_999)).toBe('1 MB');
    expect(formatBytes(2_400_000_000)).toBe('2.4 GB');
    expect(phaseLabel('linkedin', 'parsing')).toBe('Reading archive');
    expect(phaseLabel('gmail', 'history')).toBe('Checking for new mail');
    expect(phaseLabel('chrome', 'Decrypting cookies')).toBe('Decrypting cookies');
    expect(phaseLabel('gmail', null)).toBeNull();
    const now = Date.parse('2026-10-20T10:00:00Z');
    const timeline = (readyBy: string | null, last: Extra) => ({
      id: 'r',
      name: 'linkedin',
      status: 'SYNCING' as const,
      isActive: true,
      config: { linkedinSync: { readyBy, phases: [last] } },
    });
    expect(
      linkedinRunProgress(timeline('2026-10-20T10:30:00Z', { phase: 'waiting_for_export' }), now),
    ).toMatchObject({ phase: 'waiting_for_export', etaSec: 1800, pct: null });
    expect(
      linkedinRunProgress(timeline(null, { phase: 'export_requested' }), now)?.etaSec,
    ).toBeNull();
    expect(linkedinRunProgress(timeline(null, { phase: 'synced' }), now)).toBeNull();
    expect(linkedinRunProgress(undefined, now)).toBeNull();
  });
});
