/**
 * integration-accounts blackbox: how an Integration row's one account reads on
 * the wire — legacy rows, row states vs. runs, stale and row-less runs, the
 * delta poll, the LinkedIn settle and the internal writer path.
 * Registered by integration-accounts.blackbox.ts.
 */
import { randomUUID } from 'node:crypto';
import type { IntegrationStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { GOOGLE_OAUTH_SCOPES } from '../../domains/integrations/googleScopes';
import {
  accountsOf,
  assert,
  call,
  defaultAccountOf,
  DeltaResponse,
  expectStatus,
  ListResponse,
  postProgress,
  type Session,
} from './integration-accounts.support';

type Users = () => { a: Session; b: Session };

async function createLegacyRow(token: string, name: string): Promise<void> {
  const res = await call('/api/integrations', {
    method: 'POST',
    auth: token,
    body: JSON.stringify({ name, type: 'TOOL_SETUP' }),
  });
  expectStatus(res, 200, `create legacy ${name}`);
}

async function legacyDefaultAccount(users: Users): Promise<void> {
  const { a } = users();
  await createLegacyRow(a.token, 'custom_sync');
  let list = await accountsOf(a.token, 'custom_sync');
  assert(list.length === 1 && list[0].accountId === 'default', "legacy '' row is `default`");
  assert(list[0].state === 'idle', `NOT_CONNECTED row reads idle, got ${list[0].state}`);
  assert(list[0].progress === null, 'no run yet => no bar');
  const res = await postProgress(a.token, 'custom_sync', 'default', {
    runId: 'r',
    state: 'syncing',
  });
  expectStatus(res, 200, 'progress on the default account');
  const stored = await prisma.integrationSyncProgress.findMany({
    where: { userId: a.userId, provider: 'custom_sync' },
  });
  assert(stored.length === 1 && stored[0].accountId === '', "stored under accountId ''");
  list = await accountsOf(a.token, 'custom_sync');
  assert(list.length === 1 && list[0].state === 'syncing', 'a live run shows on its row');
  assert(list[0].progress?.total === null, 'no total reported => indeterminate');
}

async function legacyWholeRowDelete(users: Users): Promise<void> {
  const { a } = users();
  await createLegacyRow(a.token, 'custom_tool');
  await postProgress(a.token, 'custom_tool', 'default', { runId: 'r', state: 'syncing' });
  const res = await call('/api/integrations/custom_tool', { method: 'DELETE', auth: a.token });
  expectStatus(res, 200, 'legacy DELETE /:name');
  const progress = await prisma.integrationSyncProgress.count({
    where: { userId: a.userId, provider: 'custom_tool' },
  });
  assert(progress === 0, 'the whole-row delete also clears that row progress');
  assert((await accountsOf(a.token, 'custom_tool')).length === 0, 'nothing is listed');
}

async function createRow(
  userId: string,
  name: string,
  status: IntegrationStatus,
  failureReason?: string
) {
  return prisma.integration.create({
    data: { userId, name, type: 'DATA_SOURCE', status, failureReason: failureReason ?? null },
  });
}

/** The wire states the bar and the red dot read, from row statuses and runs. */
async function rowStatesOnTheWire(users: Users): Promise<void> {
  const { a } = users();
  await createRow(a.userId, 'state_failed', 'SYNC_FAILED', 'token revoked');
  await createRow(a.userId, 'state_expired', 'EXPIRED', 'session expired');
  await createRow(a.userId, 'state_synced', 'CONNECTED');
  await createRow(a.userId, 'state_off', 'NOT_CONNECTED');
  const read = async (name: string) => {
    const account = await defaultAccountOf(a.token, name);
    assert(account !== undefined, `${name} is listed`);
    return account;
  };
  let failed = await read('state_failed');
  assert(failed.state === 'sync_failed' && failed.lastError === 'token revoked', 'sync_failed');
  const synced = await read('state_synced');
  assert(synced.state === 'synced' && synced.progress === null, 'CONNECTED reads synced, no bar');

  // A run that ended failed reads sync_failed with the writer's error.
  await postProgress(a.token, 'state_failed', 'default', {
    runId: 'f',
    state: 'failed',
    error: 'upload rejected',
  });
  failed = await read('state_failed');
  assert(failed.state === 'sync_failed', `a failed run reads sync_failed, got ${failed.state}`);
  assert(failed.lastError === 'upload rejected', 'lastError is the run error');

  // EXPIRED lights the red dot even over a synced run.
  await postProgress(a.token, 'state_expired', 'default', { runId: 's', state: 'synced' });
  const expired = await read('state_expired');
  assert(expired.state === 'EXPIRED', `EXPIRED wins, got ${expired.state}`);
  assert(expired.lastError === 'session expired', 'EXPIRED shows the row failure reason');

  // A disconnected row never shows a finished run's bar.
  await postProgress(a.token, 'state_off', 'default', { runId: 's', state: 'synced' });
  const off = await read('state_off');
  assert(off.state === 'idle' && off.progress === null, 'NOT_CONNECTED hides a finished run');
  await postProgress(a.token, 'state_off', 'default', {
    runId: 'live',
    state: 'syncing',
    done: 2,
    total: 4,
    unit: 'records',
  });
  const live = await read('state_off');
  assert(live.state === 'syncing' && live.progress?.pct === 50, 'but a live run shows its bar');
}

/** A Google credential that must be reconnected lights needs_reconnect on the Gmail row. */
async function gmailNeedsReconnect(users: Users): Promise<void> {
  const { a } = users();
  const tag = randomUUID().slice(0, 8);
  const row = await createRow(a.userId, 'gmail', 'CONNECTED');
  await prisma.emailIntegrationCredential.createMany({
    data: [
      {
        userId: a.userId,
        integrationId: row.id,
        provider: 'GMAIL',
        email: `work.${tag}@example.com`,
        accessToken: 'fake',
        scopes: [...GOOGLE_OAUTH_SCOPES],
      },
      {
        userId: a.userId,
        integrationId: row.id,
        provider: 'GMAIL',
        email: `home.${tag}@example.com`,
        state: 'needs_reconnect',
        lastErrorReason: 'invalid_grant',
        scopes: [...GOOGLE_OAUTH_SCOPES],
      },
    ],
  });
  await postProgress(a.token, 'gmail', 'default', {
    runId: 'g',
    state: 'syncing',
    done: 5,
    total: 50,
    unit: 'messages',
  });
  const list = await accountsOf(a.token, 'gmail');
  assert(list.length === 1, `one account for the one Gmail row, got ${list.length}`);
  const [gmail] = list;
  assert(gmail.state === 'needs_reconnect', `needs_reconnect beats a run, got ${gmail.state}`);
  assert(gmail.lastError === 'invalid_grant', 'the reconnect reason is shown');
  assert(gmail.progress?.pct === 10, 'the bar numbers are still reported');
  assert(
    gmail.label?.split(', ').sort().join(', ') ===
      [`work.${tag}@example.com`, `home.${tag}@example.com`].sort().join(', '),
    `label contains both credential addresses, got ${gmail.label}`
  );
}

/** A syncing run whose writer vanished falls back to its row; a row-less run disappears. */
async function staleRunsFallBack(users: Users): Promise<void> {
  const { a } = users();
  await createRow(a.userId, 'stale_sync', 'CONNECTED');
  await postProgress(a.token, 'stale_sync', 'default', { runId: 's', state: 'syncing', done: 1 });
  await postProgress(a.token, 'stale_rowless', 'default', { runId: 's', state: 'syncing' });
  let account = await defaultAccountOf(a.token, 'stale_sync');
  assert(account?.state === 'syncing', 'a fresh run shows');
  assert((await defaultAccountOf(a.token, 'stale_rowless'))?.state === 'syncing', 'row-less too');
  const old = new Date(Date.now() - 16 * 60_000);
  await prisma.integrationSyncProgress.updateMany({
    where: { userId: a.userId, provider: { in: ['stale_sync', 'stale_rowless'] } },
    data: { updatedAt: old },
  });
  account = await defaultAccountOf(a.token, 'stale_sync');
  assert(account?.state === 'synced' && account.progress === null, 'stale run => the row state');
  assert((await defaultAccountOf(a.token, 'stale_rowless')) === undefined, 'stale row-less: gone');
}

async function deltaPoll(users: Users): Promise<void> {
  const { a } = users();
  const first = await call('/api/integrations/progress', { auth: a.token });
  expectStatus(first, 200, 'delta without since');
  const full = DeltaResponse.parse(first.data);
  assert(full.changed, 'no cursor => changed');
  const listed = ListResponse.parse((await call('/api/integrations', { auth: a.token })).data);
  assert(
    JSON.stringify(full.accountsByProvider) === JSON.stringify(listed.accountsByProvider),
    `the delta and the list derive identical accounts:\n${JSON.stringify(full.accountsByProvider)}\n${JSON.stringify(listed.accountsByProvider)}`
  );
  // Finish every live run so nothing of A's is mid-sync.
  await prisma.integrationSyncProgress.updateMany({
    where: { userId: a.userId, state: 'syncing' },
    data: { state: 'synced', finishedAt: new Date() },
  });
  await prisma.integration.updateMany({
    where: { userId: a.userId, status: 'SYNCING' },
    data: { status: 'CONNECTED' },
  });
  const future = new Date(Date.now() + 60_000).toISOString();
  const quiet = DeltaResponse.parse(
    (await call(`/api/integrations/progress?since=${future}`, { auth: a.token })).data
  );
  assert(!quiet.changed, 'nothing changed and nothing is syncing => changed false');
  assert(
    Object.keys(quiet.accountsByProvider).length > 0,
    'accountsByProvider is always the full map'
  );
  const before = new Date(Date.now() - 1_000).toISOString();
  await postProgress(a.token, 'delta_probe', 'default', { runId: 'd', state: 'syncing', done: 3 });
  const moved = DeltaResponse.parse(
    (await call(`/api/integrations/progress?since=${before}`, { auth: a.token })).data
  );
  assert(moved.changed, 'a progress write flips changed');
  const probe = moved.accountsByProvider.delta_probe?.[0];
  assert(probe?.progress?.done === 3, 'the delta carries the new progress');
  const stillSyncing = DeltaResponse.parse(
    (await call(`/api/integrations/progress?since=${future}`, { auth: a.token })).data
  );
  assert(stillSyncing.changed, 'a live run keeps the poll changed (its view can go stale)');
}

async function linkedinSettleAgrees(users: Users): Promise<void> {
  const { a } = users();
  await prisma.integration.create({
    data: {
      userId: a.userId,
      name: 'linkedin',
      type: 'DATA_SOURCE',
      status: 'SYNCING',
      config: { syncAgentId: randomUUID() },
    },
  });
  const listed = await defaultAccountOf(a.token, 'linkedin');
  assert(
    listed?.state === 'sync_failed',
    `a dead export agent reads sync_failed, got ${listed?.state}`
  );
  const delta = DeltaResponse.parse(
    (await call('/api/integrations/progress', { auth: a.token })).data
  );
  const polled = delta.accountsByProvider.linkedin?.find((x) => x.accountId === 'default');
  assert(JSON.stringify(polled) === JSON.stringify(listed), 'the delta settles LinkedIn too');
}

async function internalWriterPath(users: Users): Promise<void> {
  const { a } = users();
  const res = await call('/api/integrations/linkedin/accounts/default/progress', {
    method: 'POST',
    internalUserId: a.userId,
    body: JSON.stringify({ runId: 'job', state: 'syncing', phase: 'importing', unit: 'records' }),
  });
  expectStatus(res, 200, 'internal API-key writer');
  const account = await defaultAccountOf(a.token, 'linkedin');
  assert(account?.progress?.phase === 'importing', 'phase round trips');
}

export function cases(users: Users): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    { name: "legacy accountId '' is the default account", fn: () => legacyDefaultAccount(users) },
    {
      name: 'whole-row DELETE /:name clears that row progress',
      fn: () => legacyWholeRowDelete(users),
    },
    {
      name: 'row states on the wire: sync_failed, EXPIRED, idle',
      fn: () => rowStatesOnTheWire(users),
    },
    {
      name: 'Gmail: a credential to reconnect lights needs_reconnect on the one row',
      fn: () => gmailNeedsReconnect(users),
    },
    {
      name: 'stale runs fall back to the row; row-less ones vanish',
      fn: () => staleRunsFallBack(users),
    },
    { name: 'delta poll: changed flag, cursor, identical full view', fn: () => deltaPoll(users) },
    {
      name: 'LinkedIn read-time settle: list and delta agree',
      fn: () => linkedinSettleAgrees(users),
    },
    { name: 'internal API-key writer path', fn: () => internalWriterPath(users) },
  ];
}
