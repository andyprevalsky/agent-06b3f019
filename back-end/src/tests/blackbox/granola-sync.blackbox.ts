#!/usr/bin/env tsx
/**
 * Granola integration: one-click sign-in, then meetings sync into the grep
 * document store.
 *
 * Runs the real sign-in and sync against the real database with Granola (its
 * OAuth server and its MCP server, speaking the real MCP SDK transport)
 * replaced at the `fetch` boundary; searches go through the real backend grep
 * route. What must stay true:
 *
 *   - sign-in registers a client and sends the user to Granola with PKCE and
 *     a state bound to them; only that exact, unexpired state completes it;
 *     tokens are stored encrypted;
 *   - every meeting becomes a structured note, a summary and a raw transcript
 *     document, each grep-able on its own and all together ("granola");
 *   - later syncs keep it current: edited summaries update in place, new
 *     meetings arrive, deleted ones leave grep, final transcripts are not
 *     re-downloaded;
 *   - older history is backfilled in windows across runs;
 *   - an expired access token is refreshed (rotation persisted); a revoked
 *     grant marks the connection EXPIRED and agents see it as not connected;
 *   - a refused transcript (plan/admin) leaves the other layers syncing;
 *   - a user is synced by one run at a time; disconnect deletes everything.
 */

import { generateKeyPairSync, randomUUID } from 'crypto';
import { prisma } from '../../providers/database';
import {
  GranolaSignInError,
  completeGranolaSignIn,
  disconnectGranola,
  getGranolaStatus,
  startGranolaSignIn,
  syncGranolaUser,
} from '../../services/integrations/granolaSync';
import { assert, equal, runSuite, type TestCase } from './google-workspace-sync.blackbox.helpers';
import {
  BASE_URL,
  apiHeaders,
  assertBody,
  assertStatus,
  requestGrep,
  requestSourceStatus,
} from './data-grep.helpers';
import {
  DAY,
  FakeGranola,
  REDIRECT,
  T0,
  at,
  daysAgo,
  meeting,
} from './granola-sync.blackbox.helpers';

process.env.GRANOLA_MCP_MIN_INTERVAL_MS = '0';
if (process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY === undefined) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  ).toString('base64');
}

async function withUser(run: (userId: string) => Promise<void>): Promise<void> {
  const userId = randomUUID();
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    await run(userId);
  } finally {
    await prisma.user.delete({ where: { userId } });
  }
}

async function signIn(userId: string, granola: FakeGranola, now = T0): Promise<void> {
  const { authorizeUrl } = await startGranolaSignIn(userId, {
    redirectUri: REDIRECT,
    fetcher: granola.fetcher,
    now,
  });
  const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
  await completeGranolaSignIn(userId, state, 'good-code', { fetcher: granola.fetcher, now });
}

async function signInError(
  userId: string,
  state: string,
  granola: FakeGranola,
  now = T0
): Promise<string | null> {
  try {
    await completeGranolaSignIn(userId, state, 'good-code', { fetcher: granola.fetcher, now });
    return null;
  } catch (error) {
    return error instanceof GranolaSignInError ? error.code : String(error);
  }
}

async function grepGranola(userId: string, pattern: string, documentSource: string) {
  const res = await requestGrep(userId, {
    pattern,
    source: 'documents',
    filters: { document_source: documentSource },
  });
  assertStatus(res.status, 200, res.data);
  return assertBody(res.data);
}

async function liveRows(userId: string) {
  return prisma.userDataDocument.findMany({
    where: { userId, source: { startsWith: 'granola' }, deletedAt: null },
    orderBy: [{ externalId: 'asc' }, { source: 'asc' }],
  });
}

async function liveIds(userId: string): Promise<string> {
  return [...new Set((await liveRows(userId)).map((row) => row.externalId))].sort().join(',');
}

async function gateConnected(userId: string, sources: string): Promise<boolean[]> {
  const gate = await requestSourceStatus(userId, sources);
  assertStatus(gate.status, 200, gate.data);
  return (gate.data as { statuses: Array<{ connected: boolean }> }).statuses.map(
    (s) => s.connected
  );
}

const tests: TestCase[] = [];
function test(name: string, fn: TestCase['fn']): void {
  tests.push({ name, fn });
}

test('sign-in binds PKCE and state to the user and stores tokens encrypted', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    const { authorizeUrl } = await startGranolaSignIn(userId, {
      redirectUri: REDIRECT,
      fetcher: granola.fetcher,
      now: T0,
    });
    const url = new URL(authorizeUrl);
    equal(url.origin + url.pathname, 'https://mcp-auth.granola.ai/oauth2/authorize', 'endpoint');
    equal(url.searchParams.get('client_id'), 'client-xyz', 'registered client');
    equal(url.searchParams.get('code_challenge_method'), 'S256', 'PKCE');
    equal(url.searchParams.get('resource'), 'https://mcp.granola.ai/mcp', 'resource');
    assert(url.searchParams.get('scope')?.includes('offline_access'), 'asks for refresh');
    const state = url.searchParams.get('state') ?? '';
    assert(state.startsWith(`${userId}.`), 'state names the user');
    equal((await getGranolaStatus(userId)).connected, false, 'not connected before callback');

    equal(await signInError(userId, `${userId}.forged`, granola), 'STATE_INVALID', 'forged state');
    equal(await signInError(userId, state, granola), null, 'the real state completes');
    const status = await getGranolaStatus(userId);
    equal(status.connected, true, 'connected');
    equal(status.accountEmail, 'andy@example.com', 'account from get_account_info');
    const row = await prisma.userDataProviderSyncState.findUniqueOrThrow({
      where: { userId_source: { userId, source: 'granola' } },
    });
    const stored = JSON.stringify(row.config);
    assert(!stored.includes(granola.accessToken), 'access token encrypted');
    assert(!stored.includes(granola.refreshToken), 'refresh token encrypted');
    assert(!stored.includes('"pending"'), 'the pending sign-in is consumed');
    const integration = await prisma.integration.findFirstOrThrow({
      where: { userId, name: 'granola' },
    });
    equal(integration.accountEmail, 'andy@example.com', 'integration chip email');
    equal(await signInError(userId, state, granola), 'STATE_INVALID', 'a state completes once');
  });
});

test('an expired sign-in is refused', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    const { authorizeUrl } = await startGranolaSignIn(userId, {
      redirectUri: REDIRECT,
      fetcher: granola.fetcher,
      now: T0,
    });
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    const later = new Date(T0.getTime() + 20 * 60_000);
    equal(await signInError(userId, state, granola, later), 'STATE_EXPIRED', 'expired');
    equal((await getGranolaStatus(userId)).connected, false, 'still not connected');
  });
});

async function post(userId: string, path: string, body: unknown) {
  const response = await fetch(`${BASE_URL}/api/integrations/granola${path}`, {
    method: 'POST',
    headers: apiHeaders(userId),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { error?: string } };
}

test('a sign-in completes only for the user who started it, once', async () => {
  await withUser(async (victim) => {
    await withUser(async (attacker) => {
      const granola = new FakeGranola();
      const { authorizeUrl } = await startGranolaSignIn(attacker, {
        redirectUri: REDIRECT,
        fetcher: granola.fetcher,
        now: T0,
      });
      const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
      equal(await signInError(victim, state, granola), 'STATE_INVALID', "another user's state");
      equal((await getGranolaStatus(victim)).connected, false, 'victim not connected');
      equal(granola.tokenRequests.length, 0, 'no code exchange for a foreign state');

      equal(await signInError(attacker, state, granola), null, 'the owner completes');
      const tokensAfter = JSON.stringify(
        (
          await prisma.userDataProviderSyncState.findUniqueOrThrow({
            where: { userId_source: { userId: attacker, source: 'granola' } },
          })
        ).config
      );
      const exchanges = granola.tokenRequests.length;
      const replays = await Promise.all([
        signInError(attacker, state, granola),
        signInError(attacker, state, granola),
      ]);
      equal(replays.join(','), 'STATE_INVALID,STATE_INVALID', 'a used state is refused');
      equal(granola.tokenRequests.length, exchanges, 'replays never reach Granola');
      const row = await prisma.userDataProviderSyncState.findUniqueOrThrow({
        where: { userId_source: { userId: attacker, source: 'granola' } },
      });
      equal(JSON.stringify(row.config), tokensAfter, 'stored tokens untouched by replays');
    });
  });
});

test('the sign-in routes accept only the frontend callback and a code with state', async () => {
  await withUser(async (userId) => {
    const offsite = await post(userId, '/oauth/start', {
      redirectUri: 'https://evil.example.com/integrations/granola/callback',
    });
    equal(offsite.status, 400, 'foreign origin');
    equal(offsite.body.error, 'REDIRECT_URI_NOT_ALLOWED', 'foreign origin code');
    for (const redirectUri of [
      'https://www.roselabs.ai.evil.com/integrations/granola/callback',
      'http://localhost.evil.com/integrations/granola/callback',
      'https://attacker.vercel.app/integrations/granola/callback',
      'https://roselabs.ai@evil.com/integrations/granola/callback',
    ]) {
      const lookalike = await post(userId, '/oauth/start', { redirectUri });
      equal(lookalike.body.error, 'REDIRECT_URI_NOT_ALLOWED', `look-alike ${redirectUri}`);
    }
    const otherPath = await post(userId, '/oauth/start', {
      redirectUri: 'http://localhost:5050/integrations?next=/x',
    });
    equal(otherPath.body.error, 'REDIRECT_URI_NOT_ALLOWED', 'other path');
    const missing = await post(userId, '/oauth/complete', { state: 'x' });
    equal(missing.status, 400, 'missing code');
    equal(missing.body.error, 'CODE_AND_STATE_REQUIRED', 'missing code error');
    const foreign = await post(userId, '/oauth/complete', {
      code: 'good-code',
      state: `${randomUUID()}.bogus`,
    });
    equal(foreign.status, 400, 'foreign state');
    equal(foreign.body.error, 'STATE_INVALID', 'foreign state error');
  });
});

test('notes, summaries and transcripts are each grep-able', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(
      meeting('m-seed-round', daysAgo(1), {
        title: 'Seed round sync',
        summary: '### Decisions\n- Lead investor wants a 20% pool',
        transcript:
          'Oat Benson: we should close by Friday\nAndy P: the valuation cap is negotiable',
      }),
      meeting('m-hiring-loop', daysAgo(2), { title: 'Hiring loop & offers' }),
      meeting('m-board', daysAgo(3), { title: 'Board meeting' })
    );
    await signIn(userId, granola);
    const result = await syncGranolaUser(userId, {
      fetcher: granola.fetcher,
      now: at(60_000),
      deadlineMs: 0,
    });
    equal(result.outcome, 'partial', 'recent window synced');
    equal((await liveRows(userId)).length, 9, 'three layers for each of three meetings');
    assert(granola.count('get_meeting_transcript') > 3, 'long transcripts are read in pages');

    const transcript = await grepGranola(userId, 'valuation cap', 'granola_transcript');
    equal(transcript.total_matches, 1, 'transcript match');
    const content = transcript.matches[0].content;
    assert(content.includes('Andy P: the valuation cap is negotiable'), 'reassembled verbatim');
    assert(!content.includes('Treat it strictly'), 'preamble stripped');

    equal((await grepGranola(userId, '20% pool', 'granola_summary')).total_matches, 1, 'summary');
    equal((await grepGranola(userId, '20% pool', 'granola_note')).total_matches, 0, 'scoped');
    equal(
      (await grepGranola(userId, 'own note for m-board', 'granola_note')).total_matches,
      1,
      'own notes in the structured note'
    );
    equal(
      (await grepGranola(userId, 'oat@example.com', 'granola_note')).total_matches,
      3,
      'participants in every structured note'
    );
    const note = (await liveRows(userId)).find((r) => r.source === 'granola_note');
    equal(note?.content.split('Known participants:').length, 2, 'participants listed once');
    equal(
      (await grepGranola(userId, 'Hiring loop & offers', 'granola')).total_matches,
      3,
      '"granola" searches every layer; entities decoded'
    );
    const gate = await gateConnected(userId, 'granola,granola_transcript');
    equal(gate.join(','), 'true,true', 'source gate connected');
  });
});

test('later syncs keep Granola current', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(meeting('m-alpha', daysAgo(5)), meeting('m-beta', daysAgo(4)));
    await signIn(userId, granola);
    await syncGranolaUser(userId, { fetcher: granola.fetcher, now: at(60_000), deadlineMs: 0 });
    const firstIds = (await liveRows(userId)).map((r) => r.id);

    // A day later: alpha's summary edited, beta deleted, gamma is new.
    granola.calls = [];
    granola.meetings.delete('m-beta');
    granola.add(
      meeting('m-alpha', daysAgo(5), { summary: 'revised summary mentions Calypso' }),
      meeting('m-gamma', new Date(T0.getTime() + 20 * 3_600_000).toISOString())
    );
    // Edits are caught by the 48 h overlap; widen it to reach alpha.
    await prisma.userDataProviderSyncState.update({
      where: { userId_source: { userId, source: 'granola' } },
      data: { cursor: { lastPolledAt: daysAgo(4), backfillEnd: daysAgo(14), backfillDone: true } },
    });
    const second = await syncGranolaUser(userId, { fetcher: granola.fetcher, now: at(DAY) });
    equal(second.outcome, 'synced', 'second sync');
    equal(await liveIds(userId), 'm-alpha,m-gamma', 'beta removed, gamma added');
    const alpha = (await liveRows(userId)).filter((r) => r.externalId === 'm-alpha');
    assert(
      alpha.every((r) => firstIds.includes(r.id)),
      'alpha updated in place'
    );
    equal((await grepGranola(userId, 'Calypso', 'granola_summary')).total_matches, 1, 'edit');
    equal((await grepGranola(userId, 'Meeting m-beta', 'granola')).total_matches, 0, 'deleted');
    const alphaTranscriptCalls = granola.calls.filter(
      (c) => c.tool === 'get_meeting_transcript' && c.args.meeting_id === 'm-alpha'
    );
    equal(alphaTranscriptCalls.length, 0, 'a settled stored transcript is not downloaded again');
  });
});

test('older history is backfilled across runs', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(meeting('m-recent', daysAgo(2)), meeting('m-oldest', daysAgo(100)));
    await signIn(userId, granola);
    const first = await syncGranolaUser(userId, {
      fetcher: granola.fetcher,
      now: at(60_000),
      deadlineMs: 0,
    });
    equal(first.outcome, 'partial', 'deadline leaves backfill for later');
    equal(await liveIds(userId), 'm-recent', 'recent window first');
    equal((await getGranolaStatus(userId)).backfillDone, false, 'backfill pending');

    const rest = await syncGranolaUser(userId, { fetcher: granola.fetcher, now: at(120_000) });
    equal(rest.outcome, 'synced', 'backfill completes');
    equal(await liveIds(userId), 'm-oldest,m-recent', 'old meeting arrived');
    equal((await getGranolaStatus(userId)).backfillDone, true, 'backfill done');
  });
});

test('an expired access token is refreshed and the rotation persisted', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.expiresIn = 60;
    granola.add(meeting('m-alpha', daysAgo(1)));
    await signIn(userId, granola);
    const issued = granola.refreshToken;
    const opts = { fetcher: granola.fetcher, deadlineMs: 0 };
    equal(
      (await syncGranolaUser(userId, { ...opts, now: at(10 * 60_000) })).outcome,
      'partial',
      'run 1'
    );
    const refreshes = () =>
      granola.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token');
    equal(refreshes().length, 1, 'one refresh');
    equal(refreshes()[0].get('refresh_token'), issued, 'used the stored refresh token');
    const rotated = granola.refreshToken;

    equal(
      (await syncGranolaUser(userId, { ...opts, now: at(20 * 60_000) })).outcome,
      'partial',
      'run 2'
    );
    equal(refreshes().length, 2, 'second refresh');
    equal(refreshes()[1].get('refresh_token'), rotated, 'rotated refresh token was persisted');
  });
});

test('a revoked grant marks the connection expired', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(meeting('m-alpha', daysAgo(1)));
    await signIn(userId, granola);
    granola.revoked = true;
    const result = await syncGranolaUser(userId, { fetcher: granola.fetcher, now: at(60_000) });
    equal(result.outcome, 'expired', 'outcome');
    equal((await getGranolaStatus(userId)).status, 'EXPIRED', 'sync state');
    const integration = await prisma.integration.findFirstOrThrow({
      where: { userId, name: 'granola' },
    });
    equal(integration.status, 'EXPIRED', 'integration row');
    equal((await gateConnected(userId, 'granola')).join(','), 'false', 'agents see disconnected');
  });
});

test('a refused transcript leaves the other layers syncing', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(meeting('m-free', daysAgo(1), { refuseTranscript: true }));
    await signIn(userId, granola);
    await syncGranolaUser(userId, { fetcher: granola.fetcher, now: at(60_000), deadlineMs: 0 });
    equal(
      (await liveRows(userId)).map((r) => r.source).join(','),
      'granola_note,granola_summary',
      'note and summary stored, no transcript'
    );
    equal((await getGranolaStatus(userId)).status, 'CONNECTED', 'not a failure');
  });
});

test('one run at a time per user', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(meeting('m-alpha', daysAgo(1)), meeting('m-beta', daysAgo(2)));
    await signIn(userId, granola);
    const opts = { fetcher: granola.fetcher, now: at(60_000), deadlineMs: 0 };
    const results = await Promise.all([
      syncGranolaUser(userId, opts),
      syncGranolaUser(userId, opts),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    equal(outcomes.join(','), 'not_claimed,partial', 'second concurrent run does not claim');
  });
});

test('a reconnect keeps the same account; an unknown account starts clean', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(meeting('m-alpha', daysAgo(1)));
    await signIn(userId, granola);
    await syncGranolaUser(userId, { fetcher: granola.fetcher, now: at(60_000), deadlineMs: 0 });
    await signIn(userId, granola);
    equal((await liveRows(userId)).length, 3, 'same account keeps its meetings');
    granola.email = null;
    await signIn(userId, granola);
    equal((await liveRows(userId)).length, 0, 'unknown account: old meetings removed');
    const row = await prisma.userDataProviderSyncState.findUniqueOrThrow({
      where: { userId_source: { userId, source: 'granola' } },
    });
    equal(JSON.stringify(row.cursor), '{}', 'history starts over');
    await syncGranolaUser(userId, { fetcher: granola.fetcher, now: at(120_000), deadlineMs: 0 });
    granola.email = 'other@example.com';
    await signIn(userId, granola);
    equal((await liveRows(userId)).length, 0, 'unknown, then another account: removed');
  });
});

test('a meeting missing from the notes reply keeps its note and summary', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(meeting('m-alpha', daysAgo(1)));
    await signIn(userId, granola);
    await syncGranolaUser(userId, { fetcher: granola.fetcher, now: at(60_000), deadlineMs: 0 });
    const before = (await liveRows(userId)).map((r) => `${r.source}:${r.content}`);
    granola.add(meeting('m-alpha', daysAgo(1), { omitNotes: true }));
    await syncGranolaUser(userId, { fetcher: granola.fetcher, now: at(120_000), deadlineMs: 0 });
    const after = (await liveRows(userId)).map((r) => `${r.source}:${r.content}`);
    equal(after.join('|'), before.join('|'), 'note, summary and transcript unchanged');
  });
});

test('a mid-run token expiry refreshes and the run continues', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(meeting('m-alpha', daysAgo(1)), meeting('m-beta', daysAgo(2)));
    await signIn(userId, granola);
    granola.expireOn = 'get_meeting_transcript';
    const result = await syncGranolaUser(userId, {
      fetcher: granola.fetcher,
      now: at(60_000),
      deadlineMs: 0,
    });
    equal(result.outcome, 'partial', 'run completed after refresh');
    equal(await liveIds(userId), 'm-alpha,m-beta', 'every meeting stored');
    const refreshes = granola.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token');
    equal(refreshes.length, 1, 'refreshed once');
    const row = await prisma.userDataProviderSyncState.findUniqueOrThrow({
      where: { userId_source: { userId, source: 'granola' } },
    });
    const config = row.config as Record<string, unknown>;
    equal(
      Object.keys(config).sort().join(','),
      'accountEmail,encryptedTokens',
      'refresh wrote tokens only'
    );
    equal(config.accountEmail, 'andy@example.com', 'account kept');
    equal((await getGranolaStatus(userId)).status, 'CONNECTED', 'connected');
  });
});

test('a disconnect during a run leaves nothing behind', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(meeting('m-alpha', daysAgo(1)), meeting('m-beta', daysAgo(2)));
    await signIn(userId, granola);
    let transcripts = 0;
    granola.beforeTool = async (name) => {
      if (name === 'get_meeting_transcript' && ++transcripts === 2) await disconnectGranola(userId);
    };
    const result = await syncGranolaUser(userId, {
      fetcher: granola.fetcher,
      now: at(60_000),
      deadlineMs: 0,
    });
    equal(result.outcome, 'superseded', 'run stops');
    equal(
      await prisma.userDataDocument.count({ where: { userId, source: { startsWith: 'granola' } } }),
      0,
      'no documents resurrected'
    );
    equal((await getGranolaStatus(userId)).connected, false, 'still disconnected');
    equal(await prisma.integration.count({ where: { userId, name: 'granola' } }), 0, 'no row');
  });
});

test('a new sign-in during a run fences the old run out', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(meeting('m-alpha', daysAgo(1)));
    await signIn(userId, granola);
    let resigned = false;
    granola.beforeTool = async (name) => {
      if (name !== 'get_meeting_transcript' || resigned) return;
      resigned = true;
      granola.beforeTool = null;
      granola.email = 'other@example.com';
      await signIn(userId, granola);
    };
    const result = await syncGranolaUser(userId, {
      fetcher: granola.fetcher,
      now: at(60_000),
      deadlineMs: 0,
    });
    equal(result.outcome, 'superseded', 'old run stops');
    const status = await getGranolaStatus(userId);
    equal(status.status, 'CONNECTED', 'new sign-in stays connected');
    equal(status.accountEmail, 'other@example.com', 'new account kept');
    equal((await liveRows(userId)).length, 0, "old account's meeting not written");
    const next = await syncGranolaUser(userId, {
      fetcher: granola.fetcher,
      now: at(120_000),
      deadlineMs: 0,
    });
    equal(next.outcome, 'partial', 'the new connection syncs');
  });
});

test('document_source never resolves object prototype names', async () => {
  await withUser(async (userId) => {
    for (const source of ['constructor', '__proto__', 'toString']) {
      const res = await requestGrep(userId, {
        pattern: 'anything',
        source: 'documents',
        filters: { document_source: source },
      });
      assertStatus(res.status, 200, res.data);
      equal(assertBody(res.data).total_matches, 0, `${source} is an exact source`);
    }
  });
});

test('disconnect deletes the grant, sync state and every document', async () => {
  await withUser(async (userId) => {
    const granola = new FakeGranola();
    granola.add(meeting('m-alpha', daysAgo(1)));
    await signIn(userId, granola);
    await syncGranolaUser(userId, { fetcher: granola.fetcher, now: at(60_000), deadlineMs: 0 });
    equal((await liveRows(userId)).length, 3, 'documents before disconnect');

    const response = await fetch(`${BASE_URL}/api/integrations/granola`, {
      method: 'DELETE',
      headers: apiHeaders(userId),
    });
    const body = (await response.json()) as { deletedDocuments: number };
    assertStatus(response.status, 200, body);
    equal(body.deletedDocuments, 3, 'count');
    const left = await prisma.userDataDocument.count({
      where: { userId, source: { startsWith: 'granola' } },
    });
    equal(left, 0, 'documents deleted');
    equal((await getGranolaStatus(userId)).connected, false, 'sync state deleted');
    equal(await prisma.integration.count({ where: { userId, name: 'granola' } }), 0, 'row');
    equal((await disconnectGranola(userId)).deletedDocuments, 0, 'idempotent');
  });
});

if (process.argv[1]?.includes('granola-sync.blackbox')) {
  void runSuite('granola sync', tests);
}
