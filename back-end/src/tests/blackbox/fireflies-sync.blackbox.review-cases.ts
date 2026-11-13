/** Owning scheduler and unavailable-layer regressions, registered by fireflies-sync. */
import { prisma } from '../../providers/database';
import {
  syncFirefliesUser,
  runFirefliesSyncJob,
  type FirefliesSyncOptions,
} from '../../services/integrations/firefliesSync';
import {
  startGranolaSignIn,
  completeGranolaSignIn,
  syncGranolaUser,
} from '../../services/integrations/granolaSync';
import {
  FakeGranola,
  REDIRECT as GRANOLA_REDIRECT,
  T0,
  daysAgo,
  meeting,
} from './granola-sync.blackbox.helpers';
import { FakeFireflies, NOW, DAY } from './fireflies-sync.blackbox.helpers';
import { assert, equal, type TestCase } from './google-workspace-sync.blackbox.helpers';
interface ReviewContext {
  withUser(fn: (id: string, fake: FakeFireflies) => Promise<void>): Promise<void>;
  signIn(id: string, fake: FakeFireflies): Promise<string>;
  opts(fake: FakeFireflies, ms?: number): FirefliesSyncOptions;
  rows(id: string): Promise<Array<{ externalId: string; source: string; content: string }>>;
}
export function reviewCases({ withUser, signIn, opts, rows }: ReviewContext): TestCase[] {
  const tests: TestCase[] = [];
  const test = (name: string, fn: TestCase['fn']) => tests.push({ name, fn });
  test('Fireflies rate-limit reset persists across cron ticks without changing Granola retry scheduling', async () =>
    withUser(async (id, fake) => {
      fake.add('limited');
      await signIn(id, fake);
      const earliestReset = Date.now() + DAY;
      const fetcher: typeof fetch = async (input, init) => {
        const message = init?.body ? JSON.parse(String(init.body)) : {};
        if (message.params?.name === 'fireflies_get_transcripts')
          return new Response('limited', { status: 429, headers: { 'Retry-After': '86400' } });
        return fake.fetcher(input, init);
      };
      const now = new Date(NOW.getTime() + 60_000);
      equal(
        (await syncFirefliesUser(id, { ...opts(fake), fetcher })).outcome,
        'failed',
        'daily quota failure'
      );
      const state = await prisma.userDataProviderSyncState.findUniqueOrThrow({
        where: { userId_source: { userId: id, source: 'fireflies' } },
      });
      assert(
        state.nextSyncAt !== null && state.nextSyncAt.getTime() >= earliestReset,
        'daily Retry-After persisted rather than fixed 15m'
      );
      const beforeCalls = fake.calls.length;
      equal(
        await runFirefliesSyncJob({
          ...opts(fake),
          now: () => new Date(now.getTime() + 16 * 60_000),
          fetcher,
        }),
        0,
        'cron does not claim a blocked window'
      );
      equal(fake.calls.length, beforeCalls, 'no calls while quota remains blocked');
      const granola = new FakeGranola();
      granola.add(meeting('g-retry', daysAgo(1)));
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
      granola.beforeTool = async (name) => {
        if (name === 'list_meetings') throw new Error('ordinary Granola transport failure');
      };
      const granolaNow = new Date(T0.getTime() + 60_000);
      equal(
        (
          await syncGranolaUser(id, {
            fetcher: granola.fetcher,
            now: () => granolaNow,
            deadlineMs: 0,
          })
        ).outcome,
        'failed',
        'Granola ordinary failure'
      );
      const gs = await prisma.userDataProviderSyncState.findUniqueOrThrow({
        where: { userId_source: { userId: id, source: 'granola' } },
      });
      equal(
        gs.nextSyncAt?.getTime(),
        granolaNow.getTime() + 15 * 60_000,
        'Granola fixed retry interval unchanged'
      );
    }));

  for (const unavailable of [null, undefined])
    test(`unavailable transcript ${String(unavailable)} does not block notes and is fetched when ready`, async () =>
      withUser(async (id, fake) => {
        fake.add('pending', 0);
        fake.add('ready', 0);
        const pending = fake.meetings.get('pending');
        assert(pending !== undefined, 'fixture');
        pending.transcript = unavailable;
        await signIn(id, fake);
        equal(
          (await syncFirefliesUser(id, opts(fake))).outcome,
          'partial',
          'unavailable transcript does not fail window'
        );
        const first = await rows(id);
        equal(first.length, 5, 'both note/summary pairs and ready transcript persisted');
        assert(
          first.some((r) => r.externalId === 'pending' && r.source === 'fireflies_summary'),
          'pending summary is searchable'
        );
        pending.transcript = 'Later ready transcript';
        equal(
          (await syncFirefliesUser(id, opts(fake, 120_000))).outcome,
          'partial',
          'later window succeeds'
        );
        assert(
          (await rows(id)).some(
            (r) =>
              r.externalId === 'pending' &&
              r.source === 'fireflies_transcript' &&
              r.content.includes('Later ready')
          ),
          'later ready transcript fetched and indexed'
        );
        pending.transcript = unavailable;
        await syncFirefliesUser(id, opts(fake, 180_000));
        assert(
          (await rows(id)).some(
            (r) => r.externalId === 'pending' && r.source === 'fireflies_transcript'
          ),
          'unavailable response does not delete stored transcript'
        );
        pending.transcript = '';
        await syncFirefliesUser(id, opts(fake, 240_000));
        assert(
          !(await rows(id)).some(
            (r) => r.externalId === 'pending' && r.source === 'fireflies_transcript'
          ),
          'explicit empty sentences confirms no transcript'
        );
      }));

  return tests;
}
