/**
 * integration-accounts blackbox: legacy-row compatibility, container providers
 * (Gmail addresses, Plaid items), todo cleanup hooks, the delta poll and the
 * internal writer path. Registered by integration-accounts.blackbox.ts.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { upsertIntegrationAccount } from '../../domains/integrations/repo.accounts';
import { GOOGLE_OAUTH_SCOPES } from '../../domains/integrations/googleScopes';
import {
  accountsOf,
  assert,
  call,
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
  await createLegacyRow(a.token, 'gpt_code');
  let list = await accountsOf(a.token, 'gpt_code');
  assert(list.length === 1 && list[0].accountId === 'default', "legacy '' row is `default`");
  assert(list[0].state === 'idle', `NOT_CONNECTED row reads idle, got ${list[0].state}`);
  const res = await postProgress(a.token, 'gpt_code', 'default', { runId: 'r', state: 'syncing' });
  expectStatus(res, 200, 'progress on the default account');
  const stored = await prisma.integrationSyncProgress.findMany({
    where: { userId: a.userId, provider: 'gpt_code' },
  });
  assert(stored.length === 1 && stored[0].accountId === '', "stored under accountId ''");
  list = await accountsOf(a.token, 'gpt_code');
  assert(list.length === 1 && list[0].state === 'syncing', 'progress merges onto the legacy row');
  assert(list[0].progress.total === null, 'no total reported => indeterminate');

  await upsertIntegrationAccount({
    userId: a.userId,
    name: 'gpt_code',
    accountId: 'chatgpt-2',
    type: 'TOOL_SETUP',
    legacy: 'separate',
    status: 'CONNECTED',
  });
  const del = await call('/api/integrations/gpt_code/accounts/default', {
    method: 'DELETE',
    auth: a.token,
  });
  expectStatus(del, 200, 'delete the default account');
  list = await accountsOf(a.token, 'gpt_code');
  assert(list.length === 1 && list[0].accountId === 'chatgpt-2', 'the real account survives');
  const legacyRow = await prisma.integration.count({
    where: { userId: a.userId, name: 'gpt_code', accountId: '' },
  });
  assert(legacyRow === 0, "the '' row is gone");
}

async function legacyWholeRowDelete(users: Users): Promise<void> {
  const { a } = users();
  await createLegacyRow(a.token, 'custom_tool');
  await postProgress(a.token, 'custom_tool', 'default', { runId: 'r', state: 'synced' });
  const res = await call('/api/integrations/custom_tool', { method: 'DELETE', auth: a.token });
  expectStatus(res, 200, 'legacy DELETE /:name');
  const list = await accountsOf(a.token, 'custom_tool');
  assert(list.length === 0, 'legacy delete also clears the default account progress');
}

async function claimLegacyRow(users: Users): Promise<void> {
  const { a } = users();
  await createLegacyRow(a.token, 'notion_sync');
  await postProgress(a.token, 'notion_sync', 'default', { runId: 'r', state: 'synced' });
  const row = await upsertIntegrationAccount({
    userId: a.userId,
    name: 'notion_sync',
    accountId: 'workspace-9',
    type: 'TOOL_SETUP',
    legacy: 'claim',
    accountEmail: 'team@example.com',
  });
  assert(row.accountId === 'workspace-9', 'the legacy row was adopted');
  const list = await accountsOf(a.token, 'notion_sync');
  assert(list.length === 1, `one account after claim, got ${list.length}`);
  assert(list[0].accountId === 'workspace-9' && list[0].state === 'synced', 'progress moved');
  assert(list[0].label === 'team@example.com', 'label from accountEmail');
  const second = await upsertIntegrationAccount({
    userId: a.userId,
    name: 'notion_sync',
    accountId: 'workspace-10',
    type: 'TOOL_SETUP',
    legacy: 'claim',
  });
  assert(second.id !== row.id, 'connecting another account creates a new row');
  assert((await accountsOf(a.token, 'notion_sync')).length === 2, 'two accounts after reconnect');
}

async function gmailAddressesAreAccounts(users: Users): Promise<void> {
  const { a } = users();
  const tag = randomUUID().slice(0, 8);
  const [work, home] = [`work.${tag}@example.com`, `home.${tag}@example.com`];
  const integration = await prisma.integration.create({
    data: { userId: a.userId, name: 'gmail', type: 'TOOL_SETUP', status: 'CONNECTED' },
  });
  await prisma.emailIntegrationCredential.createMany({
    data: [
      {
        userId: a.userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: work,
        accessToken: 'fake',
        // A full grant: a scope-less credential correctly reads needs_reconnect.
        scopes: [...GOOGLE_OAUTH_SCOPES],
      },
      {
        userId: a.userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: home,
        state: 'needs_reconnect',
        lastErrorReason: 'invalid_grant',
        scopes: [...GOOGLE_OAUTH_SCOPES],
      },
    ],
  });
  await postProgress(a.token, 'gmail', work, { runId: 'g', state: 'syncing', done: 5, total: 50 });
  await postProgress(a.token, 'gmail', home, { runId: 'g', state: 'syncing', done: 1 });
  const list = await accountsOf(a.token, 'gmail');
  const byId = new Map(list.map((x) => [x.accountId, x]));
  assert(list.length === 2, `two Gmail addresses, got ${list.length}`);
  assert(
    byId.get(work)?.state === 'syncing' && byId.get(work)?.progress.pct === 10,
    `work syncing at 10%, got ${JSON.stringify(byId.get(work))}`
  );
  assert(byId.get(home)?.state === 'needs_reconnect', 'needs_reconnect beats progress');
  assert(byId.get(home)?.lastError === 'invalid_grant', 'reconnect reason shown');

  const del = await call(`/api/integrations/gmail/accounts/${encodeURIComponent(home)}`, {
    method: 'DELETE',
    auth: a.token,
  });
  expectStatus(del, 200, 'delete one Gmail address');
  const after = await accountsOf(a.token, 'gmail');
  assert(after.length === 1 && after[0].accountId === work, 'the other address survives');
  const purge = await prisma.googleDataPurge.count({
    where: { userId: a.userId, email: home.toLowerCase() },
  });
  assert(purge === 1, 'deleting the address queues its Google data purge');
}

async function plaidItemsAreAccounts(users: Users): Promise<void> {
  const { a } = users();
  const integration = await prisma.integration.create({
    data: { userId: a.userId, name: 'plaid', type: 'DATA_SOURCE', status: 'CONNECTED' },
  });
  const item = (name: string, cursor: string | null) =>
    prisma.plaidItem.create({
      data: {
        userId: a.userId,
        integrationId: integration.id,
        plaidItemId: `item-${randomUUID()}`,
        institutionName: name,
        encryptedAccessToken: 'not-an-envelope',
        cursor,
      },
    });
  const [chase, amex] = [await item('Chase', 'c1'), await item('Amex', null)];
  const list = await accountsOf(a.token, 'plaid');
  const byId = new Map(list.map((x) => [x.accountId, x]));
  assert(byId.get(chase.id)?.label === 'Chase' && byId.get(chase.id)?.state === 'synced', 'Chase');
  assert(byId.get(amex.id)?.state === 'syncing', 'an item before its first sync reads syncing');
  const del = await call(`/api/integrations/plaid/accounts/${chase.id}`, {
    method: 'DELETE',
    auth: a.token,
  });
  expectStatus(del, 200, 'delete one Plaid item');
  const stored = await prisma.plaidItem.findUniqueOrThrow({ where: { id: chase.id } });
  assert(stored.status === 'DISCONNECTED', 'the item is disconnected and its token redacted');
  const after = await accountsOf(a.token, 'plaid');
  assert(after.length === 1 && after[0].accountId === amex.id, 'the other item survives');
  const again = await call(`/api/integrations/plaid/accounts/${chase.id}`, {
    method: 'DELETE',
    auth: a.token,
  });
  expectStatus(again, 404, 'a disconnected item is gone');
}

async function todoHooksRefuse(users: Users): Promise<void> {
  const { a } = users();
  for (const [provider, owner] of [
    ['atlas_passwords', 'L-INT-PASSWORDS'],
    ['whatsapp', 'L-INT-WHATSAPP'],
  ]) {
    await postProgress(a.token, provider, 'acct', { runId: 'r', state: 'synced' });
    const res = await call(`/api/integrations/${provider}/accounts/acct`, {
      method: 'DELETE',
      auth: a.token,
    });
    expectStatus(res, 501, `${provider} cleanup not implemented`);
    assert(res.data.owner === owner, `${provider} hook owned by ${owner}`);
    const kept = await prisma.integrationSyncProgress.count({
      where: { userId: a.userId, provider, accountId: 'acct' },
    });
    assert(kept === 1, `${provider}: nothing is deleted when cleanup is not implemented`);
  }
}

async function deltaPoll(users: Users): Promise<void> {
  const { a } = users();
  const first = await call('/api/integrations/progress', { auth: a.token });
  expectStatus(first, 200, 'delta without since');
  const full = DeltaResponse.parse(first.data);
  assert(full.changed && full.accountsByProvider !== undefined, 'no cursor => full accounts');
  const listed = ListResponse.parse((await call('/api/integrations', { auth: a.token })).data);
  assert(
    JSON.stringify(full.accountsByProvider) === JSON.stringify(listed.accountsByProvider),
    `the delta and the list derive identical accounts:\n${JSON.stringify(full.accountsByProvider)}\n${JSON.stringify(listed.accountsByProvider)}`
  );
  const future = new Date(Date.now() + 60_000).toISOString();
  const quiet = DeltaResponse.parse(
    (await call(`/api/integrations/progress?since=${future}`, { auth: a.token })).data
  );
  assert(!quiet.changed && quiet.accountsByProvider === undefined, 'nothing changed => no body');
  const before = new Date(Date.now() - 1_000).toISOString();
  await postProgress(a.token, 'imessage', 'mac-delta', { runId: 'd', state: 'syncing', done: 3 });
  const moved = DeltaResponse.parse(
    (await call(`/api/integrations/progress?since=${before}`, { auth: a.token })).data
  );
  assert(moved.changed, 'a progress write flips changed');
  const mac = moved.accountsByProvider?.imessage?.find((x) => x.accountId === 'mac-delta');
  assert(mac?.progress.done === 3, 'the delta carries the new progress');
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
  const listed = (await accountsOf(a.token, 'linkedin')).find((x) => x.accountId === 'default');
  assert(listed?.state === 'failed', `a dead export agent reads failed, got ${listed?.state}`);
  const delta = DeltaResponse.parse(
    (await call('/api/integrations/progress', { auth: a.token })).data
  );
  const polled = delta.accountsByProvider?.linkedin?.find((x) => x.accountId === 'default');
  assert(JSON.stringify(polled) === JSON.stringify(listed), 'the delta settles LinkedIn too');
  const future = new Date(Date.now() + 60_000).toISOString();
  const probe = DeltaResponse.parse(
    (await call(`/api/integrations/progress?since=${future}`, { auth: a.token })).data
  );
  assert(probe.changed, 'a SYNCING LinkedIn row can settle at any time, so it is never quiet');
}

async function seedCookie(
  userId: string,
  browserSource: string,
  browserProfile: string,
  domain: string,
  name: string
): Promise<void> {
  await prisma.cookie.create({
    data: { userId, browserSource, browserProfile, domain, name, path: '/', value: `${name}-val` },
  });
}

/**
 * I6: a cookie provider's accounts are its browser PROFILES. Two Edge profiles
 * (Default, Profile 1) list separately; a legacy empty-profile Chrome snapshot
 * is the `default` account; deleting one profile removes exactly that profile's
 * cookies and leaves the other; progress merges onto the matching profile.
 */
async function cookieProfilesAreAccounts(users: Users): Promise<void> {
  const { a } = users();
  // Production always upserts the browser Integration row when cookies sync.
  await prisma.integration.create({
    data: { userId: a.userId, name: 'edge', type: 'DATA_SOURCE', status: 'CONNECTED' },
  });
  await seedCookie(a.userId, 'edge', 'Default', '.example.com', 'sid');
  await seedCookie(a.userId, 'edge', 'Default', '.other.com', 'auth');
  await seedCookie(a.userId, 'edge', 'Profile 1', '.work.com', 'session');

  let edge = await accountsOf(a.token, 'edge');
  const byId = new Map(edge.map((x) => [x.accountId, x]));
  assert(edge.length === 2, `two Edge profiles listed separately, got ${edge.length}`);
  assert(
    byId.has('edge:Default') && byId.has('edge:Profile 1'),
    'accountId is <browser>:<profile>'
  );
  assert(byId.get('edge:Default')?.label === 'Default', 'profile dir is the label');
  assert(byId.get('edge:Default')?.state === 'synced', 'a synced profile reads synced');
  assert(byId.get('edge:Profile 1')?.label === 'Profile 1', 'second profile label');

  // Progress from known counts merges onto the matching profile account.
  const prog = await postProgress(a.token, 'edge', 'edge:Default', {
    runId: 'c1',
    state: 'syncing',
    done: 1,
    total: 2,
    unit: 'cookies',
  });
  expectStatus(prog, 200, 'cookie profile progress write');
  edge = await accountsOf(a.token, 'edge');
  const def = edge.find((x) => x.accountId === 'edge:Default');
  assert(def?.state === 'syncing', 'an in-flight re-sync shows syncing over the synced health');
  assert(
    def?.progress.done === 1 && def.progress.total === 2 && def.progress.pct === 50,
    `done/total/pct from counts, got ${JSON.stringify(def?.progress)}`
  );
  assert(def?.progress.unit === 'cookies', 'unit round trips');

  // Delete one profile: exactly that profile's cookies go; the other survives.
  const delProfile = await call('/api/integrations/edge/accounts/edge%3AProfile%201', {
    method: 'DELETE',
    auth: a.token,
  });
  expectStatus(delProfile, 200, 'delete one Edge profile');
  const remainingProfile1 = await prisma.cookie.count({
    where: { userId: a.userId, browserSource: 'edge', browserProfile: 'Profile 1' },
  });
  assert(remainingProfile1 === 0, 'the deleted profile has no cookies left');
  const remainingDefault = await prisma.cookie.count({
    where: { userId: a.userId, browserSource: 'edge', browserProfile: 'Default' },
  });
  assert(remainingDefault === 2, "the other profile's cookies are untouched");
  edge = await accountsOf(a.token, 'edge');
  assert(
    edge.length === 1 && edge[0].accountId === 'edge:Default',
    'only the surviving Edge profile is listed'
  );

  // Delete the last profile: its cookies and its progress row go too.
  const delDefault = await call('/api/integrations/edge/accounts/edge%3ADefault', {
    method: 'DELETE',
    auth: a.token,
  });
  expectStatus(delDefault, 200, 'delete the last Edge profile');
  const edgeCookies = await prisma.cookie.count({
    where: { userId: a.userId, browserSource: 'edge' },
  });
  assert(edgeCookies === 0, 'all Edge cookies are gone');
  const edgeProgress = await prisma.integrationSyncProgress.count({
    where: { userId: a.userId, provider: 'edge', accountId: 'edge:Default' },
  });
  assert(edgeProgress === 0, 'the profile progress row is gone');
}

/** A legacy empty-profile cookie snapshot maps to the `default` account. */
async function legacyCookieProfileIsDefault(users: Users): Promise<void> {
  const { a } = users();
  await prisma.integration.create({
    data: { userId: a.userId, name: 'chrome', type: 'DATA_SOURCE', status: 'CONNECTED' },
  });
  await seedCookie(a.userId, 'chrome', '', '.legacy.com', 'old');
  const chrome = await accountsOf(a.token, 'chrome');
  assert(
    chrome.length === 1 && chrome[0].accountId === 'default',
    `legacy '' profile is the default account, got ${JSON.stringify(chrome.map((x) => x.accountId))}`
  );
  const del = await call('/api/integrations/chrome/accounts/default', {
    method: 'DELETE',
    auth: a.token,
  });
  expectStatus(del, 200, 'delete the legacy Chrome cookie account');
  const left = await prisma.cookie.count({ where: { userId: a.userId, browserSource: 'chrome' } });
  assert(left === 0, 'the legacy cookie rows are removed');
}

/** browser_fingerprint has one `default` account; delete drops its row. */
async function fingerprintDeleteRemovesRow(users: Users): Promise<void> {
  const { a } = users();
  await prisma.integration.create({
    data: {
      userId: a.userId,
      name: 'browser_fingerprint',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      config: { fingerprint: { navigator: {}, screen: {} } },
    },
  });
  const list = await accountsOf(a.token, 'browser_fingerprint');
  assert(list.length === 1 && list[0].accountId === 'default', 'one default fingerprint account');
  const del = await call('/api/integrations/browser_fingerprint/accounts/default', {
    method: 'DELETE',
    auth: a.token,
  });
  expectStatus(del, 200, 'delete the fingerprint account');
  const rows = await prisma.integration.count({
    where: { userId: a.userId, name: 'browser_fingerprint' },
  });
  assert(rows === 0, 'the fingerprint integration row is gone');
  const again = await call('/api/integrations/browser_fingerprint/accounts/default', {
    method: 'DELETE',
    auth: a.token,
  });
  expectStatus(again, 404, 'a removed fingerprint account is gone');
}

async function internalWriterPath(users: Users): Promise<void> {
  const { a } = users();
  const res = await call('/api/integrations/linkedin/accounts/li-internal/progress', {
    method: 'POST',
    internalUserId: a.userId,
    body: JSON.stringify({ runId: 'job', state: 'syncing', phase: 'export_requested' }),
  });
  expectStatus(res, 200, 'internal API-key writer');
  const account = (await accountsOf(a.token, 'linkedin')).find(
    (x) => x.accountId === 'li-internal'
  );
  assert(account?.progress.phase === 'export_requested', 'phase round trips');
}

export function cases(users: Users): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    { name: "legacy accountId '' is the default account", fn: () => legacyDefaultAccount(users) },
    { name: 'legacy DELETE /:name clears default progress', fn: () => legacyWholeRowDelete(users) },
    { name: 'claiming a legacy row moves its progress', fn: () => claimLegacyRow(users) },
    {
      name: 'Gmail addresses are accounts; delete one',
      fn: () => gmailAddressesAreAccounts(users),
    },
    { name: 'Plaid items are accounts; delete one', fn: () => plaidItemsAreAccounts(users) },
    { name: 'todo cleanup hooks answer 501 and keep data', fn: () => todoHooksRefuse(users) },
    {
      name: 'cookie profiles are separate accounts; delete one keeps the other',
      fn: () => cookieProfilesAreAccounts(users),
    },
    {
      name: 'legacy empty-profile cookies are the default account',
      fn: () => legacyCookieProfileIsDefault(users),
    },
    {
      name: 'browser_fingerprint delete removes its row',
      fn: () => fingerprintDeleteRemovesRow(users),
    },
    { name: 'delta poll: changed flag, cursor, identical view', fn: () => deltaPoll(users) },
    {
      name: 'LinkedIn read-time settle: list and delta agree',
      fn: () => linkedinSettleAgrees(users),
    },
    { name: 'internal API-key writer path', fn: () => internalWriterPath(users) },
  ];
}
