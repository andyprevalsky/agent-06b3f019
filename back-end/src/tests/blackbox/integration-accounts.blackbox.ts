#!/usr/bin/env tsx
/**
 * Black-box tests for per-account integration sync progress + multi-account
 * integrations (plan row I0).
 *
 * Domain surface:
 *   POST   /api/integrations/:provider/accounts/:accountId/progress
 *   DELETE /api/integrations/:provider/accounts/:accountId
 *   GET    /api/integrations/progress?since=
 *   GET    /api/integrations            (additive: row.accounts + accountsByProvider)
 *   DELETE /api/integrations/:name      (legacy whole-row delete keeps working)
 *
 * Invariants covered:
 *   - progress round trip; pct derived from done/total; indeterminate total stays null
 *   - monotonic per run: seq / state / done regressions are stale (409), replays are
 *     duplicates, a finished run is sticky, a new runId resets and retires the old one
 *   - coalescing: a syncing write inside 1 s of the last one is not written (202)
 *   - concurrent first writes create exactly one row (per-account lock)
 *   - two accounts per provider; deleting one keeps the other; repeat delete is 404
 *   - owner scoping: another user's account is 404 and never listed
 *   - legacy accountId '' is the `default` account (progress, delete, legacy DELETE)
 *   - claiming a legacy row moves its progress to the real account id
 *   - container providers: Gmail addresses and Plaid items are accounts; needs_reconnect wins
 *   - providers without account-scoped cleanup answer 501 and keep their data
 *   - iMessage: one account per Mac device id; delete removes exactly that Mac's messages
 *   - passwords/passkeys (I7): one row per source+profile, each a deletable account
 *     with batch progress; credential readers prefer one login deterministically
 *   - WhatsApp (I2): one account per linked phone; deleting one removes exactly its
 *     messages and the contacts only WhatsApp created; legacy history follows its claim
 *   - validation 400s, per-user account cap, internal API-key writer path, auth 401
 *   - Plaid per-item sync progress (I5): indeterminate total while syncing, final counts,
 *     1 s coalescing, independent items, ITEM_LOGIN_REQUIRED, webhook re-sync reuses the row
 *   - Telegram (I8): two accounts listed separately, per-account attribution, delete one
 *     account's messages only, legacy claim and default-account delete
 *   - Gmail sync (plan row I3, integration-accounts.gmail-sync.cases.ts): per-address
 *     progress with total = messagesTotal, per-batch save, resume from cursor without
 *     duplicates, independent addresses, unknown total stays null
 *
 * Usage: bash scripts/run-blackbox-tests.sh integration-accounts
 */
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { upsertIntegrationAccount } from '../../domains/integrations/repo.accounts';
import { reportIntegrationProgress } from '../../domains/integrations/service.progress';
import { MAX_PROGRESS_ACCOUNTS_PER_USER } from '../../domains/integrations/syncAccountsContract';
import { cases as advancedCases } from './integration-accounts.cases';
import { imessageCases } from './integration-accounts.imessage.cases';
import { passwordCases } from './integration-accounts.passwords.cases';
import { cases as plaidProgressCases } from './integration-accounts.plaid.cases';
import { telegramCases } from './integration-accounts.telegram.cases';
import { gmailSyncCases } from './integration-accounts.gmail-sync.cases';
import { whatsappCases } from './integration-accounts.whatsapp.cases';
import {
  accountsOf,
  anonymousSession,
  assert,
  call,
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
      const res = await postProgress(A().token, 'imessage', 'mac-1', {
        runId: 'r1',
        state: 'syncing',
        done: 10,
        total: 100,
        unit: 'messages',
        eta_sec: 30,
      });
      expectStatus(res, 200, 'first write');
      assert(res.data.applied === true, 'first write is applied');
      const account = (await accountsOf(A().token, 'imessage')).find(
        (x) => x.accountId === 'mac-1'
      );
      assert(account !== undefined, 'progress-only account is listed before its row exists');
      assert(account.state === 'syncing', `state syncing, got ${account.state}`);
      assert(account.progress.pct === 10, `pct 10, got ${account.progress.pct}`);
      assert(account.progress.done === 10 && account.progress.total === 100, 'counts round trip');
      assert(account.progress.unit === 'messages' && account.progress.eta_sec === 30, 'unit/eta');
      assert(account.label === null, 'no label is invented for a progress-only account');
    },
  },
  {
    name: 'indeterminate total stays null; writer pct only while total is unknown',
    fn: async () => {
      const token = A().token;
      let res = await postProgress(token, 'whatsapp', 'wa-1', {
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
          provider: 'whatsapp',
          accountId: 'wa-2',
          input: { runId: 'r1', state: 'syncing', ...input },
          now: at,
        });
      let outcome = await write({ pct: 40 }, now);
      assert(outcome.snapshot.progress.pct === 40, 'writer pct is used while total is unknown');
      outcome = await write({ done: 25, total: 100, pct: 99 }, later(2_000));
      assert(outcome.snapshot.progress.pct === 25, 'a known total wins over a writer pct');
      outcome = await write({ done: 1, total: 3 }, later(4_000));
      assert(outcome.applied === false && outcome.reason === 'stale', 'done regression is stale');
      outcome = await write({ done: 1, total: 3, phase: 'parsing' }, later(6_000));
      assert(outcome.applied, 'a new phase may restart its counts');
      assert(
        outcome.snapshot.progress.pct === 33.3,
        `pct 33.3, got ${outcome.snapshot.progress.pct}`
      );
      res = await postProgress(token, 'whatsapp', 'wa-2', { runId: 'r1', state: 'synced' });
      expectStatus(res, 200, 'synced write');
      const synced = (await accountsOf(token, 'whatsapp')).find((x) => x.accountId === 'wa-2');
      assert(synced?.state === 'synced' && synced.progress.pct === 100, 'synced reads 100%');
      assert(synced.lastSyncAt !== null, 'synced sets lastSyncAt');
    },
  },
  {
    name: 'monotonic per run: stale, duplicate, sticky finish, new run retires old',
    fn: async () => {
      const token = A().token;
      const post = (body: Record<string, unknown>) => postProgress(token, 'telegram', 'tg-1', body);
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
        where: { userId: A().userId, provider: 'telegram', accountId: 'tg-1' },
      });
      assert(rows === 1, `one row per account, got ${rows}`);
    },
  },
  {
    name: 'coalescing: syncing writes inside 1 s are not written; transitions always are',
    fn: async () => {
      const t0 = new Date();
      const at = (ms: number) => new Date(t0.getTime() + ms);
      const write = (done: number, ms: number, state: 'syncing' | 'synced' = 'syncing') =>
        reportIntegrationProgress({
          userId: A().userId,
          provider: 'linkedin',
          accountId: 'li-1',
          input: { runId: 'r1', state, done, total: 1_000_000 },
          now: at(ms),
        });
      assert((await write(1_000, 0)).applied, 'first batch written');
      const coalesced = await write(2_000, 400);
      assert(coalesced.applied === false && coalesced.reason === 'coalesced', 'coalesced');
      assert(coalesced.retryAfterMs === 600, `retryAfterMs 600, got ${coalesced.retryAfterMs}`);
      assert(coalesced.snapshot.progress.done === 1_000, 'stored progress unchanged');
      assert((await write(3_000, 1_100)).applied, 'written once the window passed');
      assert((await write(4_000, 1_200, 'synced')).applied, 'a transition is never coalesced');
    },
  },
  {
    name: 'concurrent first writes for one account create exactly one row',
    fn: async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          postProgress(A().token, 'imessage', 'mac-race', {
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
        where: { userId: A().userId, provider: 'imessage', accountId: 'mac-race' },
      });
      assert(rows === 1, `exactly one row, got ${rows}`);
    },
  },
  {
    name: 'two accounts per provider; delete one keeps the other; repeat delete is 404',
    fn: async () => {
      const userId = A().userId;
      for (const [accountId, email] of [
        ['acct-1', 'work@example.com'],
        ['acct-2', 'home@example.com'],
      ]) {
        await upsertIntegrationAccount({
          userId,
          name: 'claude_code',
          accountId,
          type: 'TOOL_SETUP',
          legacy: 'separate',
          accountEmail: email,
          status: 'CONNECTED',
          isActive: true,
        });
      }
      await postProgress(A().token, 'claude_code', 'acct-1', { runId: 'r', state: 'synced' });
      let list = await accountsOf(A().token, 'claude_code');
      assert(list.length === 2, `two accounts, got ${list.length}`);
      assert(
        list.some((x) => x.accountId === 'acct-2' && x.label === 'home@example.com'),
        'each account carries its own label'
      );
      const res = await call('/api/integrations/claude_code/accounts/acct-1', {
        method: 'DELETE',
        auth: A().token,
      });
      expectStatus(res, 200, 'delete acct-1');
      list = await accountsOf(A().token, 'claude_code');
      assert(list.length === 1 && list[0].accountId === 'acct-2', 'acct-2 survives');
      const progress = await prisma.integrationSyncProgress.count({
        where: { userId, provider: 'claude_code', accountId: 'acct-1' },
      });
      assert(progress === 0, 'the deleted account progress row is gone');
      const again = await call('/api/integrations/claude_code/accounts/acct-1', {
        method: 'DELETE',
        auth: A().token,
      });
      expectStatus(again, 404, 'repeat delete');
    },
  },
  {
    name: 'owner scoping: another user cannot see or delete my accounts',
    fn: async () => {
      const res = await call('/api/integrations/claude_code/accounts/acct-2', {
        method: 'DELETE',
        auth: B().token,
      });
      expectStatus(res, 404, "B deleting A's account");
      const mine = await accountsOf(A().token, 'claude_code');
      assert(
        mine.some((x) => x.accountId === 'acct-2'),
        "A's account is untouched"
      );
      const theirs = await call('/api/integrations', { auth: B().token });
      const parsed = ListResponse.parse(theirs.data);
      assert(
        Object.keys(parsed.accountsByProvider).length === 0,
        "B's list contains none of A's accounts"
      );
      expectStatus(
        await postProgress(B().token, 'imessage', 'mac-1', { runId: 'b', state: 'idle' }),
        200,
        'B writes its own row for the same key'
      );
      const aMac = (await accountsOf(A().token, 'imessage')).find((x) => x.accountId === 'mac-1');
      assert(aMac?.state === 'syncing', "B's write did not touch A's progress");
    },
  },
  {
    name: 'list shape: existing fields kept, accounts per row, accountsByProvider',
    fn: async () => {
      const res = await call('/api/integrations', { auth: A().token });
      expectStatus(res, 200, 'GET /api/integrations');
      const parsed = ListResponse.parse(res.data);
      assert(parsed.count === parsed.integrations.length, 'count unchanged');
      const claude = parsed.integrations.find((row) => row.name === 'claude_code');
      assert(claude !== undefined, 'claude_code row listed');
      assert(
        JSON.stringify(claude.accounts) === JSON.stringify(parsed.accountsByProvider.claude_code),
        "every row carries its provider's full account list"
      );
      assert(claude.accounts.length === 1, 'only the surviving Claude account is listed');
      assert(Array.isArray(parsed.authenticatedDomains), 'authenticatedDomains kept');
    },
  },
  {
    name: 'auth + validation: 401 without a token, 400 on a bad body or provider',
    fn: async () => {
      const anon = await call('/api/integrations/imessage/accounts/x/progress', {
        method: 'POST',
        body: JSON.stringify({ runId: 'r', state: 'syncing' }),
      });
      expectStatus(anon, 401, 'no auth');
      const token = A().token;
      expectStatus(await postProgress(token, 'imessage', 'x', { state: 'syncing' }), 400, 'runId');
      expectStatus(
        await postProgress(token, 'imessage', 'x', { runId: 'r', state: 'syncing', extra: 1 }),
        400,
        'unknown field'
      );
      expectStatus(
        await postProgress(token, 'imessage', 'x', { runId: 'r', state: 'done' }),
        400,
        'unknown state'
      );
      expectStatus(
        await postProgress(token, 'Bad%20Name', 'x', { runId: 'r', state: 'syncing' }),
        400,
        'provider slug'
      );
      expectStatus(
        await postProgress(token, 'imessage', 'x', { runId: 'r', state: 'syncing', done: -1 }),
        400,
        'negative count'
      );
      expectStatus(
        await call('/api/integrations/progress?since=nope', { auth: token }),
        400,
        'since'
      );
    },
  },
  {
    name: 'per-user account cap answers 409 instead of growing without bound',
    fn: async () => {
      const capped = await anonymousSession();
      await prisma.integrationSyncProgress.createMany({
        data: Array.from({ length: MAX_PROGRESS_ACCOUNTS_PER_USER }, (_, i) => ({
          userId: capped.userId,
          provider: 'imessage',
          accountId: `cap-${i}`,
          runId: 'seed',
        })),
      });
      const res = await postProgress(capped.token, 'imessage', 'one-more', {
        runId: 'r',
        state: 'syncing',
      });
      expectStatus(res, 409, 'over the cap');
      assert(res.data.error === 'ACCOUNT_LIMIT_EXCEEDED', 'typed cap error');
      const existing = await postProgress(capped.token, 'imessage', 'cap-0', {
        runId: 'r2',
        state: 'syncing',
      });
      expectStatus(existing, 200, 'existing accounts still write');
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
  const tests = [
    ...coreCases,
    ...advancedCases(users),
    ...plaidProgressCases(),
    ...passwordCases(),
    ...telegramCases(),
    ...gmailSyncCases(),
    ...imessageCases(users),
    ...whatsappCases(),
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
    await cleanup([A().userId, B().userId]);
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
