/**
 * A teammate's agent can grep the owner's shared WhatsApp, LinkedIn, Granola, Fireflies and Plaid
 * data through POST /api/data/grep, scoped to exactly the shared account, revalidated in SQL at
 * read time, and nothing private leaks. Shares are created and removed through the Teams HTTP API.
 */
import assert from 'node:assert/strict';
import { prisma } from '../../providers/database';
import { registerTeamAccess, type TeamDataGrant } from '../../providers/teamAccess';
import * as teamsService from '../../domains/teams/service';
import {
  countDocumentGrepRows,
  countMessageGrepRows,
  countTransactionGrepRows,
} from '../../domains/data/grepRepo';
import { executeGatelessGrepTool } from '../../domains/data/grepTool';
import { apiHeaders, BASE_URL, requestGrep } from './data-grep.helpers';
import {
  cleanupTeamIntegrationsFixture,
  seedTeamIntegrationsFixture,
  type TeamIntegrationsFixture,
} from './data-teams-integrations.fixture';

interface Ownership {
  owner_user_id: string;
  provider: string;
  account_id: string | null;
  shared: boolean;
  team_ids: string[];
  owner_name: string | null;
}
interface Currency {
  owner_user_id: string;
  currency: string;
  count: number;
  outflow: string;
  inflow: string;
}
interface GrepBody {
  total_matches: number;
  matches: Array<{ path: string; content: string; ownership?: Ownership }>;
  message?: string;
  summaries?: { transactions?: { currencies: Currency[] } };
  unavailable_sources?: unknown[];
}
type Counts = Record<'whatsapp' | 'linkedin' | 'granola' | 'fireflies' | 'plaid', number>;

async function teamsCall(userId: string, path: string, method: string, status: number) {
  const response = await fetch(`${BASE_URL}/api/teams${path}`, {
    method,
    headers: apiHeaders(userId),
    ...(method === 'PUT' ? { body: '{}' } : {}),
  });
  assert.equal(response.status, status, `${method} ${path}: ${await response.text()}`);
}

function harness(f: TeamIntegrationsFixture) {
  const grep = async (params: Record<string, unknown>, userId = f.ids.reader) => {
    const response = await requestGrep(userId, { pattern: f.marker, head_limit: 50, ...params });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data as GrepBody;
  };
  const total = async (params: Record<string, unknown>, userId = f.ids.reader) =>
    (await grep(params, userId)).total_matches;
  /** Each shared account's rows, through the real route. */
  const counts = async (
    scope: Record<string, unknown> = { team_id: f.teams.atlas },
    userId = f.ids.reader
  ): Promise<Counts> => ({
    whatsapp: await total({ source: 'messages', account_id: 'whatsapp', ...scope }, userId),
    linkedin: await total({ source: 'messages', account_id: 'linkedin', ...scope }, userId),
    granola: await total({ source: 'documents', account_id: 'granola', ...scope }, userId),
    fireflies: await total({ source: 'documents', account_id: 'fireflies', ...scope }, userId),
    plaid: await total({ source: 'transactions', account_id: f.items.shared.id, ...scope }, userId),
  });
  let stale: TeamDataGrant[] = [];
  const grant = (provider: string) => {
    const found = stale.find((row) => row.provider === provider && row.ownerUserId === f.ids.owner);
    assert.ok(found, `stale ${provider} grant captured`);
    return found;
  };
  /** The same counts from grants resolved BEFORE a revocation: SQL must revalidate them. */
  const sqlCounts = async (): Promise<Counts> => {
    const access = (provider: string) => ({
      userId: f.ids.reader,
      search: { teamId: f.teams.atlas },
      grants: [grant(provider)],
    });
    const query = { pattern: f.marker, caseInsensitive: false };
    const message = (provider: string) =>
      countMessageGrepRows({ ...query, userId: f.ids.reader, access: access(provider) });
    const document = (provider: string) =>
      countDocumentGrepRows({ ...query, access: access(provider) });
    return {
      whatsapp: await message('whatsapp'),
      linkedin: await message('linkedin'),
      granola: await document('granola'),
      fireflies: await document('fireflies'),
      plaid: await countTransactionGrepRows({ ...query, access: access('plaid') }),
    };
  };
  const captureStale = async () => {
    stale = await teamsService.resolveTeamDataAccess(f.ids.reader, { teamId: f.teams.atlas });
  };
  return { grep, total, counts, sqlCounts, captureStale };
}
type Harness = ReturnType<typeof harness>;
const ALL = { whatsapp: 2, linkedin: 2, granola: 2, fireflies: 1, plaid: 2 };
const NONE = { whatsapp: 0, linkedin: 0, granola: 0, fireflies: 0, plaid: 0 };

async function shareEverything(f: TeamIntegrationsFixture) {
  const atlas = `/${f.teams.atlas}/integrations`;
  for (const row of ['whatsapp', 'linkedin', 'granola', 'fireflies'] as const)
    await teamsCall(f.ids.owner, `${atlas}/${f.owner[row].id}`, 'PUT', 200);
  await teamsCall(f.ids.owner, `${atlas}/${f.owner.whatsapp.id}`, 'PUT', 200); // idempotent
  // One Plaid row, two institution logins: the integration id is ambiguous, an item id is exact.
  await teamsCall(f.ids.owner, `${atlas}/${f.owner.plaid.id}`, 'PUT', 400);
  await teamsCall(f.ids.owner, `${atlas}/${f.items.shared.id}`, 'PUT', 200);
  await teamsCall(f.ids.reader, `${atlas}/${f.readerPlaid.id}`, 'PUT', 200); // reader's one item
  await teamsCall(f.ids.reader, `${atlas}/${f.items.private.id}`, 'PUT', 400); // not theirs
  await teamsCall(f.ids.invited, `${atlas}/${f.owner.whatsapp.id}`, 'PUT', 404); // not a member
  const rows = await prisma.teamIntegrationShare.findMany({
    where: { teamId: f.teams.atlas, ownerUserId: f.ids.owner },
  });
  const stored = Object.fromEntries(rows.map((row) => [row.provider, row]));
  assert.equal(rows.length, 5, 'one share per exact account');
  assert.equal(stored.whatsapp.accountId, '');
  assert.equal(stored.linkedin.accountEmail, null);
  assert.equal(stored.granola.accountEmail, 'owner.notes@example.test', 'pinned, lowercased');
  assert.equal(stored.plaid.accountId, f.items.shared.id, 'Plaid share names the item');
}

async function assertMessages(f: TeamIntegrationsFixture, h: Harness) {
  const atlas = { team_id: f.teams.atlas };
  const whatsapp = await h.grep({ source: 'whatsapp', ...atlas });
  assert.equal(whatsapp.total_matches, 2);
  for (const match of whatsapp.matches)
    assert.deepEqual(match.ownership, {
      owner_user_id: f.ids.owner,
      provider: 'whatsapp',
      account_id: 'whatsapp',
      shared: true,
      team_ids: [f.teams.atlas],
      owner_name: 'Integrations owner',
    });
  const all = await h.grep({ source: 'messages', ...atlas, '-C': 10 });
  assert.equal(all.total_matches, 4, 'shared WhatsApp + LinkedIn only');
  assert.ok(!JSON.stringify(all).includes('PRIVATE'), 'private channels never enter context');
  const linkedin = await h.grep({ source: 'messages', account_id: 'linkedin', ...atlas });
  assert.deepEqual(
    linkedin.matches.map((match) => [match.ownership?.provider, match.ownership?.account_id]),
    [
      ['linkedin', 'linkedin'],
      ['linkedin', 'linkedin'],
    ]
  );
  const ownAndShared = await h.grep({ source: 'messages', account_id: 'whatsapp' });
  assert.equal(
    ownAndShared.total_matches,
    3,
    "account_id selects the channel in the reader's scope"
  );
  const own = ownAndShared.matches.find((match) => match.ownership?.owner_user_id === f.ids.reader);
  assert.equal(own?.ownership?.shared, false);
  assert.equal(own?.ownership?.account_id, 'whatsapp');
  assert.equal(await h.total({ source: 'messages' }), 5, 'default scope: own + shared');
  assert.equal(await h.total({ source: 'messages', account_id: '' }), 0, "'' is still iMessage");
  assert.equal(await h.total({ source: 'imessage', ...atlas }), 0, 'unshared iMessage');
  assert.equal(await h.total({ source: 'email', ...atlas }), 0, 'unshared email');
  assert.equal(await h.total({ source: 'messages', owner_user_id: f.ids.owner }), 4);
  assert.equal(await h.total({ source: 'messages', team_id: f.teams.orbit }), 0);
}

async function assertDocuments(f: TeamIntegrationsFixture, h: Harness) {
  const atlas = { team_id: f.teams.atlas };
  const shared = await h.grep({ source: 'documents', ...atlas });
  assert.equal(shared.total_matches, 3, 'granola layers + fireflies summary');
  assert.ok(!JSON.stringify(shared).includes('PRIVATE'), 'private documents stay private');
  assert.ok(!(shared.message ?? '').includes('outside this sharing scope'), shared.message);
  for (const match of shared.matches) {
    const provider = match.path.split('/')[1].split('_')[0];
    assert.deepEqual(match.ownership, {
      owner_user_id: f.ids.owner,
      provider,
      account_id: provider,
      shared: true,
      team_ids: [f.teams.atlas],
      owner_name: 'Integrations owner',
    });
  }
  assert.equal(await h.total({ source: 'documents', ...atlas, account_id: 'granola' }), 2);
  assert.equal(
    await h.total({ source: 'documents', ...atlas, filters: { document_source: 'fireflies' } }),
    1
  );
  const defaultScope = await h.grep({ source: 'documents' });
  assert.equal(defaultScope.total_matches, 5, 'default scope: own documents + shared notes');
  assert.ok(!JSON.stringify(defaultScope).includes('PRIVATE'));
  assert.equal(await h.total({ source: 'documents', account_id: 'granola' }), 3);
  // A printed path addresses exactly the owner's document, never widening the scope.
  const note = shared.matches.find((match) => match.path.startsWith('documents/granola_note/'));
  assert.ok(note);
  const byPath = await h.grep({ source: 'documents', filters: { path: note.path } });
  assert.deepEqual(
    byPath.matches.map((match) => [match.path, match.ownership?.owner_user_id]),
    [[note.path, f.ids.owner]]
  );
  const ownerView = await h.grep(
    { source: 'documents', filters: { document_source: 'chatgpt' } },
    f.ids.owner
  );
  assert.equal(ownerView.total_matches, 1, 'owner still reads their private export');
  const privatePath = ownerView.matches[0].path;
  for (const scope of [{}, atlas, { owner_user_id: f.ids.owner }])
    assert.equal(
      await h.total({ source: 'documents', filters: { path: privatePath }, ...scope }),
      0,
      `private path stays private in ${JSON.stringify(scope)}`
    );
  const orbit = await h.grep({ source: 'documents', team_id: f.teams.orbit });
  assert.equal(orbit.total_matches, 0);
  assert.ok(
    (orbit.message ?? '').includes('documents: private source is outside this sharing scope.')
  );
}

async function assertTransactions(f: TeamIntegrationsFixture, h: Harness) {
  const mine = await h.grep({ source: 'transactions' });
  assert.equal(
    mine.total_matches,
    1,
    "shared financial data never joins the reader's default scope"
  );
  assert.ok(!JSON.stringify(mine).includes('SHARED'));
  assert.deepEqual(
    mine.summaries?.transactions?.currencies.map((row) => [row.owner_user_id, row.count]),
    [[f.ids.reader, 1]]
  );
  const named = await h.grep({ source: 'transactions', account_id: f.items.shared.id });
  assert.equal(named.total_matches, 0);
  assert.ok(
    (named.message ?? '').includes(
      'transactions: a shared Plaid account is searched only with an explicit team_id or owner_user_id.'
    ),
    named.message
  );
  const team = await h.grep({ source: 'transactions', team_id: f.teams.atlas });
  assert.equal(team.total_matches, 3, "owner's shared item + reader's own shared item");
  assert.ok(!JSON.stringify(team).includes('PRIVATE'), 'unshared item never read');
  for (const match of team.matches.filter((row) => row.ownership?.owner_user_id === f.ids.owner))
    assert.deepEqual(match.ownership, {
      owner_user_id: f.ids.owner,
      provider: 'plaid',
      account_id: f.items.shared.id,
      shared: true,
      team_ids: [f.teams.atlas],
      owner_name: 'Integrations owner',
    });
  const totals = new Map(
    (team.summaries?.transactions?.currencies ?? []).map((row) => [row.owner_user_id, row])
  );
  assert.equal(totals.size, 2, 'totals are one row per owner, never mixed');
  assert.equal(totals.get(f.ids.owner)?.count, 2);
  assert.equal(Number(totals.get(f.ids.owner)?.outflow), 5);
  assert.equal(Number(totals.get(f.ids.owner)?.inflow), 100);
  assert.equal(totals.get(f.ids.reader)?.count, 1);
  assert.equal(await h.total({ source: 'transactions', owner_user_id: f.ids.owner }), 2);
  assert.equal(
    await h.total({
      source: 'transactions',
      team_id: f.teams.atlas,
      account_id: f.items.private.id,
    }),
    0
  );
  assert.equal(await h.total({ source: 'transactions', team_id: f.teams.orbit }), 0);
}

async function assertMapAndGating(f: TeamIntegrationsFixture, h: Harness) {
  const response = await fetch(`${BASE_URL}/api/data/team-context`, {
    headers: apiHeaders(f.ids.reader),
  });
  const map = (await response.json()) as {
    accounts: Array<{
      ownerUserId: string;
      provider: string;
      accountId: string;
      label: string | null;
    }>;
  };
  const owned = map.accounts
    .filter((row) => row.ownerUserId === f.ids.owner)
    .map((row) => [row.provider, row.accountId, row.label])
    .sort();
  assert.deepEqual(owned, [
    ['fireflies', 'fireflies', 'owner-calls@example.test'],
    ['granola', 'granola', 'Owner.Notes@Example.test'],
    ['linkedin', 'linkedin', null],
    ['plaid', f.items.shared.id, 'Atlas Credit Union'],
    ['whatsapp', 'whatsapp', null],
  ]);
  assert.ok(!JSON.stringify(map).includes(f.items.private.id), 'unshared item absent from map');
  const summary = await h.grep({
    source: 'summary',
    team_id: f.teams.atlas,
    account_id: 'granola',
  });
  assert.ok((summary.message ?? '').includes('"accountId":"granola"'), summary.message);
  assert.ok(!(summary.message ?? '').includes('"provider":"whatsapp"'), summary.message);
  // The peer has no connectors of its own: shared accounts must not be gated on them.
  const status = await fetch(
    `${BASE_URL}/api/data/source-status?sources=whatsapp,granola,meeting_notes,transactions,imessage`,
    { headers: apiHeaders(f.ids.peer) }
  );
  const statuses = (
    (await status.json()) as { statuses: Array<{ source: string; connected: boolean }> }
  ).statuses;
  assert.deepEqual(Object.fromEntries(statuses.map((row) => [row.source, row.connected])), {
    whatsapp: true,
    granola: true,
    meeting_notes: true,
    transactions: false,
    imessage: false,
  });
  registerTeamAccess(teamsService);
  const tool = (args: Record<string, unknown>) =>
    executeGatelessGrepTool(f.ids.peer, { pattern: f.marker, ...args });
  const teamPlaid = await tool({ source: 'transactions', team_id: f.teams.atlas });
  assert.equal(teamPlaid.unavailable_sources, undefined, 'team scope is not gated on own Plaid');
  assert.equal(teamPlaid.total_matches, 3);
  const sharedWhatsapp = await tool({ source: 'whatsapp' });
  assert.equal(sharedWhatsapp.unavailable_sources, undefined);
  assert.equal(sharedWhatsapp.total_matches, 2);
  const notes = await tool({
    source: 'documents',
    filters: { documents: { document_source: 'granola' } },
    require_source_access: true,
  });
  assert.equal(notes.unavailable_sources, undefined);
  assert.equal(notes.total_matches, 2);
  const ownPlaid = await tool({ source: 'transactions' });
  assert.equal(ownPlaid.unavailable_sources?.length, 1, 'default scope still needs own Plaid');
}

async function assertRevocation(f: TeamIntegrationsFixture, h: Harness) {
  const atlas = `/${f.teams.atlas}/integrations`;
  const expectBoth = async (expected: Counts, label: string) => {
    assert.deepEqual(await h.counts(), expected, `route: ${label}`);
    assert.deepEqual(await h.sqlCounts(), expected, `SQL revalidation: ${label}`);
  };
  await h.captureStale();
  await expectBoth(ALL, 'shared');
  assert.deepEqual(
    await h.counts({ team_id: f.teams.atlas }, f.ids.invited),
    NONE,
    'invited reader'
  );
  assert.deepEqual(await h.counts({ team_id: f.teams.atlas }, f.ids.stranger), NONE, 'stranger');

  await teamsCall(f.ids.owner, `${atlas}/${f.owner.whatsapp.id}`, 'DELETE', 204);
  await expectBoth({ ...ALL, whatsapp: 0 }, 'WhatsApp unshared');
  await teamsCall(f.ids.owner, `${atlas}/${f.owner.whatsapp.id}`, 'PUT', 200);
  const second = await prisma.integration.create({
    data: { userId: f.ids.owner, name: 'whatsapp', accountId: 'second', type: 'DATA_SOURCE' },
  });
  await expectBoth({ ...ALL, whatsapp: 0 }, 'a second WhatsApp row makes the account ambiguous');
  await prisma.integration.delete({ where: { id: second.id } });
  await expectBoth(ALL, 'ambiguity resolved');

  const set = (id: string, data: Record<string, unknown>) =>
    prisma.integration.update({ where: { id }, data });
  await set(f.owner.linkedin.id, { status: 'NOT_CONNECTED' });
  await expectBoth({ ...ALL, linkedin: 0 }, 'LinkedIn disconnected');
  await set(f.owner.linkedin.id, { status: 'CONNECTED' });
  await set(f.owner.granola.id, { accountEmail: 'someone.else@example.test' });
  await expectBoth({ ...ALL, granola: 0 }, 'Granola signed in to another account');
  await set(f.owner.granola.id, { accountEmail: 'Owner.Notes@Example.test' });
  await set(f.owner.fireflies.id, { isActive: false });
  await expectBoth({ ...ALL, fireflies: 0 }, 'Fireflies inactive');
  await set(f.owner.fireflies.id, { isActive: true });
  for (const status of ['REQUIRES_REAUTH', 'DISCONNECTED'] as const) {
    await prisma.plaidItem.update({ where: { id: f.items.shared.id }, data: { status } });
    await expectBoth({ ...ALL, plaid: 0 }, `Plaid item ${status}`);
  }
  await prisma.plaidItem.update({ where: { id: f.items.shared.id }, data: { status: 'ACTIVE' } });
  await expectBoth(ALL, 'every account restored');

  const membership = (userId: string, status: string) =>
    prisma.teamMember.updateMany({ where: { teamId: f.teams.atlas, userId }, data: { status } });
  await membership(f.ids.reader, 'INVITED');
  await expectBoth(NONE, 'reader dropped to invited');
  await membership(f.ids.reader, 'ACCEPTED');
  await membership(f.ids.owner, 'INVITED');
  await expectBoth(NONE, 'owner dropped to invited');
  await membership(f.ids.owner, 'ACCEPTED');
  await expectBoth(ALL, 'memberships restored');

  // Unsharing a Plaid item works by its item id, even after the item disconnects.
  await prisma.plaidItem.update({
    where: { id: f.items.shared.id },
    data: { status: 'DISCONNECTED' },
  });
  await teamsCall(f.ids.owner, `${atlas}/${f.items.shared.id}`, 'DELETE', 204);
  assert.equal(
    await prisma.teamIntegrationShare.count({ where: { accountId: f.items.shared.id } }),
    0
  );
  await prisma.plaidItem.update({ where: { id: f.items.shared.id }, data: { status: 'ACTIVE' } });
  await expectBoth({ ...ALL, plaid: 0 }, 'Plaid item unshared');

  const ownerMember = await prisma.teamMember.findFirstOrThrow({
    where: { teamId: f.teams.atlas, userId: f.ids.owner },
  });
  await teamsCall(f.ids.owner, `/${f.teams.atlas}/members/${ownerMember.id}`, 'DELETE', 204);
  await expectBoth(NONE, 'owner left the team');
}

async function run() {
  const f = await seedTeamIntegrationsFixture();
  try {
    const h = harness(f);
    await shareEverything(f);
    await assertMessages(f, h);
    await assertDocuments(f, h);
    await assertTransactions(f, h);
    await assertMapAndGating(f, h);
    await assertRevocation(f, h);
    console.log(
      'PASS data-teams-integrations: WhatsApp, LinkedIn, Granola, Fireflies and Plaid sharing, scoping, revocation'
    );
  } finally {
    await cleanupTeamIntegrationsFixture(f);
    await prisma.$disconnect();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
