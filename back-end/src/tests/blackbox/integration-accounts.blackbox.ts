#!/usr/bin/env tsx
/**
 * Black-box tests for integration sync progress (the sync-progress bar): one
 * account per existing Integration row.
 *
 * Domain surface:
 *   POST   /api/integrations/:provider/accounts/:accountId/progress
 *   GET    /api/integrations/progress?since=
 *   GET    /api/integrations            (additive: row.accounts[1] + accountsByProvider)
 *   DELETE /api/integrations/:provider/accounts/default   (alias of DELETE /:name)
 *   DELETE /api/integrations/:name      (whole-row delete, clears its progress)
 *
 * Invariants covered:
 *   - progress round trip; pct derived from done/total; indeterminate total stays null
 *   - monotonic per run: seq / state / done / pct regressions are stale (409), replays
 *     are duplicates, a finished run is sticky, a new runId resets and retires the old one
 *   - coalescing: a syncing write inside 1 s of the last one is not written (202); the
 *     terminal write always lands, even right after a coalesced write or with lower counts
 *   - concurrent first writes create exactly one row (per-row lock)
 *   - every Integration row is exactly one account; no new account ids are accepted
 *   - owner scoping, the delete alias, validation 400s, unit enum, per-user cap, auth 401
 *   - row states on the wire (sync_failed, EXPIRED, needs_reconnect, idle), stale runs,
 *     progress-only first syncs, the delta poll and the LinkedIn settle
 *     (integration-accounts.cases.ts)
 *   - every pipeline's progress writes at its existing boundaries
 *     (integration-accounts.pipelines.cases.ts, integration-accounts.plaid.cases.ts)
 *
 * Usage: bash scripts/run-blackbox-tests.sh integration-accounts
 */
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { reportIntegrationProgress } from '../../domains/integrations/service.progress';
import { MAX_PROGRESS_ACCOUNTS_PER_USER } from '../../domains/integrations/syncAccountsContract';
import { cases as advancedCases } from './integration-accounts.cases';
import { cases as plaidProgressCases } from './integration-accounts.plaid.cases';
import { cases as pipelineCases } from './integration-accounts.pipelines.cases';
import {
  anonymousSession,
  assert,
  call,
  defaultAccountOf,
  expectStatus,
  ListResponse,
  postProgress,
  type Session,
} from './integration-accounts.support';
config();

const sessions: { a?: Session; b?: Session } = {};
const A = () => sessions.a!;
const B = () => sessions.b!;

const coreCases: Array<{ name: string; fn: () => Promise<void> }> = [
  {
    name: 'progress round trip: counts, unit and eta come back on the account',
    fn: async () => {
      const res = await postProgress(A().token, 'imessage', 'default', {
        runId: 'r1',
        state: 'syncing',
        done: 10,
        total: 100,
        unit: 'messages',
        eta_sec: 30,
      });
      expectStatus(res, 200, 'first write');
      assert(res.data.applied === true, 'first write is applied');
      const account = await defaultAccountOf(A().token, 'imessage');
      assert(account !== undefined, 'a live first sync is listed before its row exists');
      assert(account.state === 'syncing', `state syncing, got ${account.state}`);
      assert(account.progress?.pct === 10, `pct 10, got ${account.progress?.pct}`);
      assert(account.progress.done === 10 && account.progress.total === 100, 'counts round trip');
      assert(account.progress.unit === 'messages' && account.progress.eta_sec === 30, 'unit/eta');
      assert(account.label === null, 'no label is invented for a row-less run');
    },
  },
  {
    name: 'indeterminate total stays null; writer pct only while total is unknown',
    fn: async () => {
      const token = A().token;
      let res = await postProgress(token, 'whatsapp', 'default', {
        runId: 'r1',
        state: 'syncing',
        done: 500,
        total: null,
      });
      expectStatus(res, 200, 'indeterminate write');
      const progress = (res.data.snapshot as { progress: Record<string, unknown> }).progress;
      assert(progress.total === null && progress.pct === null, 'no total => no pct, not faked');
      assert(progress.done === 500, 'done is still reported');

      const now = new Date();
      const later = (ms: number) => new Date(now.getTime() + ms);
      const write = (input: Record<string, unknown>, at: Date) =>
        reportIntegrationProgress({
          userId: A().userId,
          provider: 'whatsapp_writer',
          accountId: '',
          input: { runId: 'r1', state: 'syncing', ...input },
          now: at,
        });
      let outcome = await write({ pct: 40 }, now);
      assert(outcome.snapshot.progress.pct === 40, 'writer pct is used while total is unknown');
      outcome = await write({ pct: 30 }, later(2_000));
      assert(outcome.applied === false && outcome.reason === 'stale', 'a lower pct is stale');
      outcome = await write({ done: 50, total: 100, pct: 99 }, later(4_000));
      assert(outcome.snapshot.progress.pct === 50, 'a known total wins over a writer pct');
      outcome = await write({ done: 1, total: 3 }, later(6_000));
      assert(outcome.applied === false && outcome.reason === 'stale', 'done regression is stale');
      outcome = await write({ done: 2, total: 3, phase: 'parsing' }, later(8_000));
      assert(outcome.applied, 'a new phase may restart its counts when pct does not drop');
      assert(
        outcome.snapshot.progress.pct === 66.6,
        `pct 66.6, got ${outcome.snapshot.progress.pct}`
      );
      res = await postProgress(token, 'whatsapp', 'default', { runId: 'r1', state: 'synced' });
      expectStatus(res, 200, 'synced write');
      const synced = await defaultAccountOf(token, 'whatsapp');
      assert(synced === undefined, 'a finished run without a row is not listed');
      const row = await prisma.integrationSyncProgress.findFirstOrThrow({
        where: { userId: A().userId, provider: 'whatsapp' },
      });
      assert(row.state === 'synced' && row.lastSyncedAt !== null, 'synced sets lastSyncedAt');
    },
  },
  {
    name: 'monotonic per run: stale, duplicate, sticky finish, new run retires old',
    fn: async () => {
      const token = A().token;
      const post = (body: Record<string, unknown>) =>
        postProgress(token, 'telegram', 'default', body);
      expectStatus(await post({ runId: 'r1', seq: 3, state: 'syncing', done: 30 }), 200, 'seq 3');
      let res = await post({ runId: 'r1', seq: 2, state: 'syncing', done: 40 });
      expectStatus(res, 409, 'lower seq');
      assert(res.data.detail === 'out_of_order', `out_of_order, got ${String(res.data.detail)}`);
      res = await post({ runId: 'r1', seq: 3, state: 'syncing', done: 30 });
      expectStatus(res, 200, 'replayed seq');
      assert(res.data.reason === 'duplicate', 'an equal seq is an idempotent replay');
      res = await post({ runId: 'r1', seq: 4, state: 'idle' });
      expectStatus(res, 409, 'state regression');
      res = await post({ runId: 'r1', seq: 5, state: 'failed', error: 'disk full' });
      expectStatus(res, 200, 'fail the run');
      res = await post({ runId: 'r1', seq: 6, state: 'syncing', done: 50 });
      expectStatus(res, 409, 'write after finish');
      assert(res.data.detail === 'run_finished', 'a finished run is sticky');
      res = await post({ runId: 'r2', state: 'syncing', done: 1, total: 10 });
      expectStatus(res, 200, 'new run');
      const snapshot = res.data.snapshot as { runId: string; progress: { done: number } };
      assert(snapshot.runId === 'r2' && snapshot.progress.done === 1, 'new run resets counts');
      res = await post({ runId: 'r1', seq: 9, state: 'syncing', done: 99 });
      expectStatus(res, 409, 'late write from retired run');
      assert(res.data.detail === 'retired_run', 'retired run ids are rejected');
      const rows = await prisma.integrationSyncProgress.count({
        where: { userId: A().userId, provider: 'telegram' },
      });
      assert(rows === 1, `one row per Integration row, got ${rows}`);
    },
  },
  {
    name: 'coalescing: syncing writes inside 1 s are dropped; the terminal write always lands',
    fn: async () => {
      const t0 = new Date();
      const at = (ms: number) => new Date(t0.getTime() + ms);
      const write = (input: { state: 'syncing' | 'synced'; done: number }, ms: number) =>
        reportIntegrationProgress({
          userId: A().userId,
          provider: 'linkedin_coalesce',
          accountId: '',
          input: { runId: 'r1', total: 1_000_000, ...input },
          now: at(ms),
        });
      assert((await write({ state: 'syncing', done: 1_000 }, 0)).applied, 'first batch written');
      const coalesced = await write({ state: 'syncing', done: 2_000 }, 400);
      assert(coalesced.applied === false && coalesced.reason === 'coalesced', 'coalesced');
      assert(coalesced.retryAfterMs === 600, `retryAfterMs 600, got ${coalesced.retryAfterMs}`);
      assert(coalesced.snapshot.progress.done === 1_000, 'stored progress unchanged');
      // The terminal write lands right after a coalesced one, even with lower counts.
      const finished = await write({ state: 'synced', done: 500 }, 450);
      assert(finished.applied, 'a terminal write is never coalesced or rejected for counts');
      assert(
        finished.snapshot.state === 'synced' && finished.snapshot.progress.pct === 100,
        `the run ends synced at 100%, got ${JSON.stringify(finished.snapshot)}`
      );
    },
  },
  {
    name: 'concurrent first writes for one row create exactly one progress row',
    fn: async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          postProgress(A().token, 'race_provider', 'default', {
            runId: 'race',
            seq: i + 1,
            state: 'syncing',
            done: i,
          })
        )
      );
      const unexpected = results.filter((r) => ![200, 202, 409].includes(r.status));
      assert(unexpected.length === 0, `no 5xx under a race: ${unexpected.map((r) => r.status)}`);
      const rows = await prisma.integrationSyncProgress.count({
        where: { userId: A().userId, provider: 'race_provider' },
      });
      assert(rows === 1, `exactly one row, got ${rows}`);
    },
  },
  {
    name: 'one account per Integration row; unknown account ids are refused',
    fn: async () => {
      const userId = A().userId;
      for (const [accountId, email] of [
        ['acct-1', 'work@example.com'],
        ['acct-2', 'home@example.com'],
      ]) {
        await prisma.integration.create({
          data: {
            userId,
            name: 'claude_code',
            accountId,
            type: 'TOOL_SETUP',
            accountEmail: email,
            status: 'CONNECTED',
            isActive: true,
          },
        });
      }
      let res = await postProgress(A().token, 'claude_code', 'acct-1', {
        runId: 'r',
        state: 'syncing',
        done: 1,
        total: 4,
        unit: 'files',
      });
      expectStatus(res, 200, "progress for an existing row's account id");
      res = await postProgress(A().token, 'claude_code', 'acct-3', { runId: 'r', state: 'idle' });
      expectStatus(res, 404, 'an account id with no Integration row');
      const listed = ListResponse.parse(
        (await call('/api/integrations', { auth: A().token })).data
      );
      const rows = listed.integrations.filter((row) => row.name === 'claude_code');
      assert(rows.length === 2, `two claude_code rows, got ${rows.length}`);
      for (const row of rows) {
        assert(
          row.accounts.length === 1 && row.accounts[0].accountId === row.accountId,
          `row ${row.accountId} carries exactly its own account`
        );
      }
      const byId = new Map(listed.accountsByProvider.claude_code.map((x) => [x.accountId, x]));
      assert(byId.size === 2, 'accountsByProvider lists each row once');
      assert(byId.get('acct-1')?.progress?.pct === 25, 'the bar is on the written row');
      assert(byId.get('acct-2')?.label === 'home@example.com', 'label from accountEmail');
      assert(byId.get('acct-2')?.progress === null, 'a row without a run has no bar');
    },
  },
  {
    name: 'delete alias: default deletes the row and its progress; others are refused',
    fn: async () => {
      const { token, userId } = A();
      let res = await call('/api/integrations', {
        method: 'POST',
        auth: token,
        body: JSON.stringify({ name: 'gpt_code', type: 'TOOL_SETUP' }),
      });
      expectStatus(res, 200, 'create the legacy gpt_code row');
      await postProgress(token, 'gpt_code', 'default', { runId: 'r', state: 'synced' });
      res = await call('/api/integrations/claude_code/accounts/acct-2', {
        method: 'DELETE',
        auth: token,
      });
      expectStatus(res, 400, 'a non-default row has no whole-row delete to alias');
      assert(res.data.error === 'ACCOUNT_DELETE_UNSUPPORTED', 'typed refusal');
      res = await call('/api/integrations/gpt_code/accounts/default', {
        method: 'DELETE',
        auth: B().token,
      });
      expectStatus(res, 404, "another user cannot delete A's row");
      res = await call('/api/integrations/gpt_code/accounts/default', {
        method: 'DELETE',
        auth: token,
      });
      expectStatus(res, 200, 'delete the default account');
      const left = await prisma.integration.count({ where: { userId, name: 'gpt_code' } });
      const progress = await prisma.integrationSyncProgress.count({
        where: { userId, provider: 'gpt_code' },
      });
      assert(left === 0 && progress === 0, 'the row and its progress are gone');
      res = await call('/api/integrations/gpt_code/accounts/default', {
        method: 'DELETE',
        auth: token,
      });
      expectStatus(res, 404, 'repeat delete');
    },
  },
  {
    name: 'owner scoping: another user never sees or moves my progress',
    fn: async () => {
      expectStatus(
        await postProgress(B().token, 'imessage', 'default', { runId: 'b', state: 'idle' }),
        200,
        'B writes its own row for the same key'
      );
      const aMac = await defaultAccountOf(A().token, 'imessage');
      assert(aMac?.state === 'syncing', "B's write did not touch A's progress");
      const theirs = ListResponse.parse(
        (await call('/api/integrations', { auth: B().token })).data
      );
      assert(theirs.accountsByProvider.claude_code === undefined, "B lists none of A's rows");
    },
  },
  {
    name: 'list shape: existing fields kept, accounts per row, accountsByProvider',
    fn: async () => {
      const res = await call('/api/integrations', { auth: A().token });
      expectStatus(res, 200, 'GET /api/integrations');
      const parsed = ListResponse.parse(res.data);
      assert(parsed.count === parsed.integrations.length, 'count unchanged');
      for (const row of parsed.integrations) {
        const listed = parsed.accountsByProvider[row.name] ?? [];
        assert(
          listed.some((x) => JSON.stringify(x) === JSON.stringify(row.accounts[0])),
          `row ${row.name}/${row.accountId} account is in accountsByProvider`
        );
      }
      assert(Array.isArray(parsed.authenticatedDomains), 'authenticatedDomains kept');
    },
  },
  {
    name: 'auth + validation: 401 without a token, 400 on a bad body, provider or unit',
    fn: async () => {
      const anon = await call('/api/integrations/imessage/accounts/default/progress', {
        method: 'POST',
        body: JSON.stringify({ runId: 'r', state: 'syncing' }),
      });
      expectStatus(anon, 401, 'no auth');
      const token = A().token;
      const bad = (body: Record<string, unknown>, label: string, provider = 'imessage') =>
        postProgress(token, provider, 'default', body).then((r) => expectStatus(r, 400, label));
      await bad({ state: 'syncing' }, 'runId');
      await bad({ runId: 'r', state: 'syncing', extra: 1 }, 'unknown field');
      await bad({ runId: 'r', state: 'done' }, 'unknown state');
      await bad({ runId: 'r', state: 'syncing' }, 'provider slug', 'Bad%20Name');
      await bad({ runId: 'r', state: 'syncing', done: -1 }, 'negative count');
      await bad({ runId: 'r', state: 'syncing', unit: 'widgets' }, 'unit outside the enum');
      expectStatus(
        await call('/api/integrations/progress?since=nope', { auth: token }),
        400,
        'since'
      );
    },
  },
  {
    name: 'per-user progress-row cap answers 409 instead of growing without bound',
    fn: async () => {
      const capped = await anonymousSession();
      await prisma.integrationSyncProgress.createMany({
        data: Array.from({ length: MAX_PROGRESS_ACCOUNTS_PER_USER }, (_, i) => ({
          userId: capped.userId,
          provider: `cap_${i}`,
          accountId: '',
          runId: 'seed',
        })),
      });
      const res = await postProgress(capped.token, 'one_more', 'default', {
        runId: 'r',
        state: 'syncing',
      });
      expectStatus(res, 409, 'over the cap');
      assert(res.data.error === 'ACCOUNT_LIMIT_EXCEEDED', 'typed cap error');
      const existing = await postProgress(capped.token, 'cap_0', 'default', {
        runId: 'r2',
        state: 'syncing',
      });
      expectStatus(existing, 200, 'existing rows still write');
      await prisma.integrationSyncProgress.deleteMany({ where: { userId: capped.userId } });
    },
  },
];

async function cleanup(userIds: string[]): Promise<void> {
  const where = { userId: { in: userIds } };
  await prisma.messageRecord.deleteMany({ where: { person: where } });
  await prisma.person.deleteMany({ where });
  await prisma.integrationSyncProgress.deleteMany({ where });
  await prisma.cookie.deleteMany({ where });
  await prisma.cookieBundle.deleteMany({ where });
  await prisma.browserPassword.deleteMany({ where });
  await prisma.plaidTransaction.deleteMany({ where });
  await prisma.plaidAccount.deleteMany({ where });
  await prisma.plaidItem.deleteMany({ where });
  await prisma.emailIntegrationCredential.deleteMany({ where });
  await prisma.googleDataPurge.deleteMany({ where });
  await prisma.integration.deleteMany({ where });
}

async function main(): Promise<void> {
  sessions.a = await anonymousSession();
  sessions.b = await anonymousSession();
  const users = () => ({ a: A(), b: B() });
  const pipelineUser = await anonymousSession();
  const tests = [
    ...coreCases,
    ...advancedCases(users),
    ...plaidProgressCases(),
    ...pipelineCases(() => pipelineUser),
  ];
  let failed = 0;
  try {
    for (const test of tests) {
      const start = Date.now();
      try {
        await test.fn();
        console.log(`  PASS  ${test.name} (${Date.now() - start}ms)`);
      } catch (err) {
        failed++;
        console.log(`  FAIL  ${test.name} -- ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await cleanup([A().userId, B().userId, pipelineUser.userId]);
    await prisma.$disconnect();
  }
  console.log(
    `\nResults: ${tests.length - failed} passed, ${failed} failed, ${tests.length} total`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nCrashed:', err);
  process.exit(1);
});
