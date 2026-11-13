#!/usr/bin/env tsx
/** Real shared pipeline + DB + HTTP routes; only Fireflies' remote fetch is faked. */
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  startFirefliesSignIn,
  completeFirefliesSignIn,
  syncFirefliesUser,
  getFirefliesStatus,
  disconnectFireflies,
  FirefliesSignInError,
} from '../../services/integrations/firefliesSync';
import {
  startGranolaSignIn,
  completeGranolaSignIn,
  syncGranolaUser,
  getGranolaStatus,
  disconnectGranola,
} from '../../services/integrations/granolaSync';
import {
  FakeGranola,
  REDIRECT as GRANOLA_REDIRECT,
  T0,
  daysAgo,
  meeting,
} from './granola-sync.blackbox.helpers';
import { reviewCases } from './fireflies-sync.blackbox.review-cases';
import { FakeFireflies, REDIRECT, NOW, DAY } from './fireflies-sync.blackbox.helpers';
import { assert, equal, runSuite, type TestCase } from './google-workspace-sync.blackbox.helpers';
import { BASE_URL, apiHeaders, requestGrep, assertBody, assertStatus } from './data-grep.helpers';
process.env.GRANOLA_MCP_MIN_INTERVAL_MS = '0';
if (process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY === undefined) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  ).toString('base64');
}
async function withUser(fn: (id: string, fake: FakeFireflies) => Promise<void>) {
  const id = randomUUID();
  await prisma.user.create({ data: { userId: id, isAnonymous: true } });
  try {
    await fn(id, new FakeFireflies());
  } finally {
    await prisma.user.delete({ where: { userId: id } });
  }
}
async function signIn(id: string, fake: FakeFireflies) {
  const { authorizeUrl } = await startFirefliesSignIn(id, {
    redirectUri: REDIRECT,
    fetcher: fake.fetcher,
    now: NOW,
  });
  const url = new URL(authorizeUrl);
  equal(
    url.origin + url.pathname,
    'https://api.fireflies.ai/authorize',
    'official authorize endpoint'
  );
  equal(url.searchParams.get('code_challenge_method'), 'S256', 'PKCE');
  equal(url.searchParams.get('scope'), 'profile email', 'advertised scopes');
  const state = url.searchParams.get('state') ?? '';
  await completeFirefliesSignIn(id, state, 'good-code', { fetcher: fake.fetcher, now: NOW });
  return state;
}
const opts = (fake: FakeFireflies, ms = 60_000) => ({
  fetcher: fake.fetcher,
  now: () => new Date(NOW.getTime() + ms),
  deadlineMs: 0,
});
const rows = (userId: string) =>
  prisma.userDataDocument.findMany({
    where: { userId, source: { startsWith: 'fireflies_' }, deletedAt: null },
    orderBy: { source: 'asc' },
  });
const tests: TestCase[] = [];
const test = (name: string, fn: TestCase['fn']) => tests.push({ name, fn });

// Pause callback A at the remote profile boundary, after it consumed its state.
// B then mutates the persisted sign-in lifecycle before A can publish a grant.
const oauthProviders = [
  {
    id: 'fireflies',
    start: startFirefliesSignIn,
    complete: completeFirefliesSignIn,
    disconnect: disconnectFireflies,
    status: getFirefliesStatus,
    now: NOW,
    redirect: REDIRECT,
    fake: () => new FakeFireflies(),
    profileTool: 'fireflies_get_user',
  },
  {
    id: 'granola',
    start: startGranolaSignIn,
    complete: completeGranolaSignIn,
    disconnect: disconnectGranola,
    status: getGranolaStatus,
    now: T0,
    redirect: GRANOLA_REDIRECT,
    fake: () => new FakeGranola(),
    profileTool: 'get_account_info',
  },
];
for (const provider of oauthProviders) {
  for (const interleaving of ['pending', 'completed', 'disconnected', 'reconnected'] as const) {
    test(`${provider.id} callback generation fences ${interleaving} sign-in`, async () =>
      withUser(async (id) => {
        const begin = async (fake: ReturnType<typeof provider.fake>) => {
          const result = await provider.start(id, {
            redirectUri: provider.redirect,
            fetcher: fake.fetcher,
            now: provider.now,
          });
          return new URL(result.authorizeUrl).searchParams.get('state') ?? '';
        };
        const complete = (state: string, fake: ReturnType<typeof provider.fake>) =>
          provider.complete(id, state, 'good-code', { fetcher: fake.fetcher, now: provider.now });
        const initial = provider.fake();
        initial.email = 'initial@example.com';
        await complete(await begin(initial), initial);
        await prisma.userDataDocument.create({
          data: {
            userId: id,
            source: `${provider.id}_note`,
            externalId: 'old-account',
            title: 'Old',
            content: 'Original account document',
            contentHash: createHash('sha256').update('Original account document').digest('hex'),
          },
        });
        const a = provider.fake();
        a.email = 'stale-a@example.com';
        const stateA = await begin(a);
        let entered!: () => void;
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const resumed = new Promise<void>((resolve) => {
          release = resolve;
        });
        a.beforeTool = async (name) => {
          if (name === provider.profileTool) {
            entered();
            await resumed;
          }
        };
        const callbackA = complete(stateA, a).then(
          () => null,
          (error: unknown) => (error instanceof FirefliesSignInError ? error.code : String(error))
        );
        await blocked;
        try {
          // Duplicate callbacks must be rejected while the first exchange is in flight.
          const duplicate = await complete(stateA, a).then(
            () => null,
            (error: unknown) => (error instanceof FirefliesSignInError ? error.code : String(error))
          );
          equal(duplicate, 'STATE_INVALID', 'in-flight duplicate callback rejected');
          if (interleaving === 'disconnected' || interleaving === 'reconnected')
            await provider.disconnect(id);
          const b = provider.fake();
          b.email = 'new-b@example.com';
          const stateB = interleaving === 'disconnected' ? null : await begin(b);
          if (stateB !== null && interleaving !== 'pending') await complete(stateB, b);
          const before = await prisma.userDataProviderSyncState.findUnique({
            where: { userId_source: { userId: id, source: provider.id } },
          });
          release();
          const outcome = await callbackA;
          const after = await prisma.userDataProviderSyncState.findUnique({
            where: { userId_source: { userId: id, source: provider.id } },
          });
          if (interleaving === 'pending') {
            equal(
              (after?.config as { pending?: { state?: string } })?.pending?.state,
              stateB,
              'newer pending state survives callback A'
            );
          }
          equal(outcome, 'STATE_INVALID', 'superseded callback rejected');
          equal(
            JSON.stringify(after?.config),
            JSON.stringify(before?.config),
            'newer pending/grant remains byte-for-byte intact'
          );
          if (interleaving === 'pending' && stateB !== null) {
            equal(
              (await provider.status(id)).accountEmail,
              'initial@example.com',
              'pending reconnect keeps current grant'
            );
            equal(
              await prisma.userDataDocument.count({
                where: { userId: id, source: `${provider.id}_note` },
              }),
              1,
              'stale callback cannot purge current documents'
            );
            await complete(stateB, b);
          }
          if (interleaving === 'disconnected') {
            equal((await provider.status(id)).connected, false, 'disconnect never resurrected');
            equal(
              await prisma.integration.count({ where: { userId: id, name: provider.id } }),
              0,
              'no integration resurrected'
            );
          } else {
            equal(
              (await provider.status(id)).accountEmail,
              'new-b@example.com',
              'newer callback can connect'
            );
            equal(
              await prisma.userDataDocument.count({
                where: { userId: id, source: `${provider.id}_note` },
              }),
              0,
              'account switch removes old account documents'
            );
            equal(
              await complete(stateA, a).then(
                () => null,
                (error: unknown) =>
                  error instanceof FirefliesSignInError ? error.code : String(error)
              ),
              'STATE_INVALID',
              'stale callback cannot replay'
            );
          }
        } finally {
          release();
          await callbackA;
        }
      }));
  }
}

tests.push(...reviewCases({ withUser, signIn, opts, rows }));

test('OAuth stores encrypted grant and rejects foreign/replayed/expired state', async () =>
  withUser(async (id, fake) => {
    const state = await signIn(id, fake);
    equal((await getFirefliesStatus(id)).accountEmail, fake.email, 'profile identity');
    const stored = await prisma.userDataProviderSyncState.findUniqueOrThrow({
      where: { userId_source: { userId: id, source: 'fireflies' } },
    });
    assert(!JSON.stringify(stored.config).includes(fake.accessToken), 'encrypted access token');
    for (const [userId, value] of [
      [randomUUID(), state],
      [id, state],
    ]) {
      let code: string | null = null;
      try {
        await completeFirefliesSignIn(userId, value, 'good-code', {
          fetcher: fake.fetcher,
          now: NOW,
        });
      } catch (e) {
        if (e instanceof FirefliesSignInError) code = e.code;
        else throw e;
      }
      equal(code, 'STATE_INVALID', 'foreign/replayed state refused');
    }
    const pending = await startFirefliesSignIn(id, {
      redirectUri: REDIRECT,
      fetcher: fake.fetcher,
      now: NOW,
    });
    let code: string | null = null;
    try {
      await completeFirefliesSignIn(
        id,
        new URL(pending.authorizeUrl).searchParams.get('state') ?? '',
        'code',
        { fetcher: fake.fetcher, now: new Date(NOW.getTime() + DAY) }
      );
    } catch (e) {
      if (e instanceof FirefliesSignInError) code = e.code;
      else throw e;
    }
    equal(code, 'STATE_EXPIRED', 'expired state refused');
  }));

test('Fireflies and Granola share storage behavior and stay isolated', async () =>
  withUser(async (id, fake) => {
    fake.add('same-id');
    await signIn(id, fake);
    const granola = new FakeGranola();
    granola.add(meeting('same-id', daysAgo(1)));
    const pending = await startGranolaSignIn(id, {
      redirectUri: GRANOLA_REDIRECT,
      fetcher: granola.fetcher,
      now: T0,
    });
    await completeGranolaSignIn(
      id,
      new URL(pending.authorizeUrl).searchParams.get('state') ?? '',
      'good-code',
      { fetcher: granola.fetcher, now: T0 }
    );
    equal(
      (
        await syncGranolaUser(id, {
          fetcher: granola.fetcher,
          now: () => new Date(T0.getTime() + 60_000),
          deadlineMs: 0,
        })
      ).outcome,
      'partial',
      'Granola shared pipeline'
    );
    equal(
      (await syncFirefliesUser(id, opts(fake))).outcome,
      'partial',
      'Fireflies shared pipeline'
    );
    equal((await rows(id)).length, 3, 'three Fireflies layers');
    const transcript = await requestGrep(id, {
      pattern: 'Hello same-id',
      source: 'documents',
      filters: { document_source: 'fireflies_transcript' },
    });
    assertStatus(transcript.status, 200, transcript.data);
    equal(
      assertBody(transcript.data).total_matches,
      1,
      'Fireflies transcript searchable through real grep'
    );
    const summary = await requestGrep(id, {
      pattern: 'Calypso',
      source: 'documents',
      filters: { document_source: 'fireflies_summary' },
    });
    equal(assertBody(summary.data).total_matches, 1, 'summary separately searchable');
    equal((await disconnectFireflies(id)).deletedDocuments, 3, 'Fireflies removed');
    equal(
      await prisma.userDataDocument.count({
        where: { userId: id, source: { startsWith: 'granola_' }, deletedAt: null },
      }),
      3,
      'Granola retained'
    );
    equal((await getGranolaStatus(id)).connected, true, 'Granola grant retained');
  }));

test('pagination is complete, updates are stable, deleted meetings are tombstoned', async () =>
  withUser(async (id, fake) => {
    for (let i = 0; i < 51; i++) fake.add(`m-${i}`);
    await signIn(id, fake);
    equal((await syncFirefliesUser(id, opts(fake))).outcome, 'partial', 'sync');
    equal((await rows(id)).length, 153, 'all pages stored');
    assert(
      fake.calls.some((c) => c.tool === 'fireflies_get_transcripts' && c.args.skip === 50),
      'second page fetched'
    );
    const original = (await rows(id)).find(
      (r) => r.externalId === 'm-1' && r.source === 'fireflies_summary'
    );
    fake.meetings.delete('m-0');
    const changed = fake.meetings.get('m-1');
    assert(changed !== undefined, 'meeting');
    changed.summary = 'Updated decision';
    await syncFirefliesUser(id, opts(fake, 120_000));
    const next = await rows(id);
    equal(next.length, 150, 'deleted meeting removed');
    const updated = next.find((r) => r.id === original?.id);
    assert(updated?.content.includes('Updated decision'), 'updated in place');
  }));

test('malformed listings and nonadvancing pagination never delete stored history', async () =>
  withUser(async (id, fake) => {
    for (let i = 0; i < 50; i++) fake.add(`m-${i}`);
    await signIn(id, fake);
    await syncFirefliesUser(id, opts(fake));
    fake.malformed = true;
    equal(
      (await syncFirefliesUser(id, opts(fake, 120_000))).outcome,
      'failed',
      'malformed reply fails closed'
    );
    equal((await rows(id)).length, 150, 'history retained');
    fake.malformed = false;
    fake.repeatPage = true;
    equal(
      (await syncFirefliesUser(id, opts(fake, 180_000))).outcome,
      'failed',
      'repeated page fails closed'
    );
    equal((await rows(id)).length, 150, 'history retained after page failure');
  }));

test('refresh rotation persists and revoked grants expire', async () =>
  withUser(async (id, fake) => {
    fake.add('m');
    fake.expiresIn = 60;
    await signIn(id, fake);
    await syncFirefliesUser(id, opts(fake, 600_000));
    const rotated = fake.refreshToken;
    await syncFirefliesUser(id, opts(fake, 1_200_000));
    equal(fake.forms[2].get('refresh_token'), rotated, 'persisted rotated token');
    fake.revoked = true;
    equal(
      (await syncFirefliesUser(id, opts(fake, 1_800_000))).outcome,
      'expired',
      'revoked refresh'
    );
    equal((await getFirefliesStatus(id)).status, 'EXPIRED', 'sync expired');
  }));

test('mid-run 401 refreshes and resumes', async () =>
  withUser(async (id, fake) => {
    fake.add('m');
    await signIn(id, fake);
    fake.expireOn = 'fireflies_get_transcript';
    equal((await syncFirefliesUser(id, opts(fake))).outcome, 'partial', 'retry after refresh');
    equal((await rows(id)).length, 3, 'all layers stored');
    equal(fake.forms.length, 2, 'one refresh');
  }));

test('claims serialize per provider and disconnect fences out in-flight writes', async () =>
  withUser(async (id, fake) => {
    fake.add('m');
    await signIn(id, fake);
    const results = await Promise.all([
      syncFirefliesUser(id, opts(fake)),
      syncFirefliesUser(id, opts(fake)),
    ]);
    equal(
      results
        .map((r) => r.outcome)
        .sort()
        .join(','),
      'not_claimed,partial',
      'one claim'
    );
    // Fetch an unsettled transcript again and disconnect before the response returns.
    fake.add('fresh', 0);
    fake.beforeTool = async (name) => {
      if (name === 'fireflies_get_transcript') {
        fake.beforeTool = null;
        await disconnectFireflies(id);
      }
    };
    equal(
      (await syncFirefliesUser(id, opts(fake, 120_000))).outcome,
      'superseded',
      'old claim fenced'
    );
    equal((await rows(id)).length, 0, 'no resurrection');
    equal((await getFirefliesStatus(id)).connected, false, 'disconnected');
  }));

test('backfill retrieves older meetings through the same cursor pipeline', async () =>
  withUser(async (id, fake) => {
    fake.add('recent', 1);
    fake.add('older', 100);
    await signIn(id, fake);
    await syncFirefliesUser(id, opts(fake));
    equal((await rows(id)).length, 3, 'recent first');
    equal(
      (await syncFirefliesUser(id, { ...opts(fake, 120_000), deadlineMs: 240_000 })).outcome,
      'synced',
      'backfill completes'
    );
    equal((await rows(id)).length, 6, 'history stored');
    equal((await getFirefliesStatus(id)).backfillDone, true, 'cursor done');
  }));

test('Fireflies routes validate its exact callback and expose status/sync/delete', async () =>
  withUser(async (id, fake) => {
    const request = async (path: string, method: string, body?: unknown) => {
      const response = await fetch(`${BASE_URL}/api/integrations/fireflies${path}`, {
        method,
        headers: apiHeaders(id),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    for (const redirectUri of [
      'https://evil.example/integrations/fireflies/callback',
      'http://localhost:5050/integrations/granola/callback',
      REDIRECT + '?next=evil',
      REDIRECT + '#hash',
    ]) {
      equal(
        (await request('/oauth/start', 'POST', { redirectUri })).body.error,
        'REDIRECT_URI_NOT_ALLOWED',
        'reject redirect'
      );
    }
    equal(
      (await request('/oauth/complete', 'POST', {})).body.error,
      'CODE_AND_STATE_REQUIRED',
      'validate callback payload'
    );
    equal(
      (await request('/sync', 'POST', {})).body.error,
      'FIREFLIES_NOT_CONNECTED',
      'sync requires grant'
    );
    equal((await request('', 'GET')).body.connected, false, 'initial status');
    await signIn(id, fake);
    equal((await request('', 'GET')).body.connected, true, 'connected status');
    equal((await request('', 'DELETE')).status, 200, 'delete route');
    equal((await request('', 'GET')).body.connected, false, 'deleted status');
  }));
if (process.argv[1]?.includes('fireflies-sync.blackbox')) void runSuite('fireflies sync', tests);
