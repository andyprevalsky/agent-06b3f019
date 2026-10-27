/**
 * plaid blackbox: sync progress of the user's `plaid` row against the live Plaid Sandbox.
 *
 *   mint + exchange (backend) ─► exchange-time sync ─► the plaid row's bar
 *   Plaid history ready ─► TRANSACTIONS webhook handler ─► same row, new run, real count
 *
 * Deterministic page-level cases (indeterminate totals, failures, re-sync runs)
 * live in integration-accounts.plaid.cases.ts. Registered by plaid.blackbox.ts,
 * which supplies its sandbox client and request helpers.
 */
import { z } from 'zod';
import { prisma } from '../../providers/database';
import { syncTransactions } from '../../providers/plaid';
import { decryptPlaidAccessTokenOrThrow } from '../../providers/plaidCredentials';
import { retryWithBackoff } from '../../providers/retry';
import { handlePlaidWebhook } from '../../domains/integrations/service.plaidWebhooks';
import { assert, ListResponse, type Account } from './integration-accounts.support';

export interface PlaidSuiteContext {
  baseUrl: string;
  request: (
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> }
  ) => Promise<{ status: number; data: unknown }>;
  authHeaders: (token: string) => Record<string, string>;
  createAnonSession: () => Promise<{ accessToken: string; userId: string }>;
  mintSandboxPublicToken: () => Promise<string>;
  isRetryablePlaidSandboxError: (error: unknown) => boolean;
}

const ExchangedItem = z.object({
  item: z.object({ id: z.string().min(1), plaidItemId: z.string().min(1) }),
});

function expectStatus(res: { status: number; data: unknown }, status: number, label: string) {
  assert(
    res.status === status,
    `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`
  );
}

async function exchangeSandboxItem(ctx: PlaidSuiteContext, accessToken: string) {
  const res = await ctx.request(`${ctx.baseUrl}/api/integrations/plaid/exchange-public-token`, {
    method: 'POST',
    headers: ctx.authHeaders(accessToken),
    body: JSON.stringify({
      public_token: await ctx.mintSandboxPublicToken(),
      institution_name: 'First Platypus Bank',
    }),
  });
  expectStatus(res, 200, 'exchange for progress');
  return ExchangedItem.parse(res.data).item;
}

async function plaidBar(ctx: PlaidSuiteContext, accessToken: string): Promise<Account> {
  const res = await ctx.request(`${ctx.baseUrl}/api/integrations`, {
    headers: ctx.authHeaders(accessToken),
  });
  expectStatus(res, 200, 'GET /api/integrations');
  const accounts = ListResponse.parse(res.data).accountsByProvider.plaid ?? [];
  assert(accounts.length === 1, `the plaid row is one account, got ${accounts.length}`);
  return accounts[0];
}

/**
 * Right after Link, Plaid is usually still preparing the Item (NOT_READY), so
 * the exchange-time run may save nothing yet; either way that run has ended and
 * reads synced in transactions, with no guessed total.
 */
function assertExchangeBar(account: Account, label: string): void {
  assert(account.state === 'synced', `${label}: synced, got ${JSON.stringify(account)}`);
  assert(account.progress?.unit === 'transactions', `${label}: counted in transactions`);
  assert(account.progress.total === null, `${label}: Plaid gives no total`);
  assert(account.progress.pct === 100, `${label}: a finished run reads 100%`);
}

/**
 * Polls Plaid (with the production /transactions/sync request, from no cursor,
 * so the stored cursor is untouched) until the Item's history is ready — the
 * moment Plaid would send its SYNC_UPDATES_AVAILABLE historical-update webhook.
 * The Sandbox can report HISTORICAL_UPDATE_COMPLETE about a second before the
 * history is readable (an empty page with an empty cursor), so ready also
 * means the page carries transactions.
 */
async function waitForPlaidHistory(ctx: PlaidSuiteContext, accessToken: string): Promise<void> {
  const page = await retryWithBackoff(() => syncTransactions(accessToken, null), {
    maxRetries: 40,
    fixedDelays: Array.from({ length: 40 }, () => 1_000),
    isRetryable: ctx.isRetryablePlaidSandboxError,
    shouldRetryResult: (res) =>
      res.transactions_update_status !== 'HISTORICAL_UPDATE_COMPLETE' || res.added.length === 0,
    component: 'PlaidSandboxHistoryWait',
  });
  assert(
    page.transactions_update_status === 'HISTORICAL_UPDATE_COMPLETE' && page.added.length > 0,
    `sandbox history readable, got ${page.transactions_update_status} with ${page.added.length} added`
  );
}

const savedTransactions = (plaidItemId: string) =>
  prisma.plaidTransaction.count({ where: { plaidItemId, removedAt: null } });

async function sandboxProgress(ctx: PlaidSuiteContext): Promise<void> {
  const { accessToken, userId } = await ctx.createAnonSession();
  const item = await exchangeSandboxItem(ctx, accessToken);
  assertExchangeBar(await plaidBar(ctx, accessToken), 'after exchange');

  const key = { userId_provider_accountId: { userId, provider: 'plaid', accountId: '' } };
  const itemRow = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
  await waitForPlaidHistory(ctx, decryptPlaidAccessTokenOrThrow(itemRow.encryptedAccessToken));
  const savedBefore = await savedTransactions(item.id);
  const before = await prisma.integrationSyncProgress.findUniqueOrThrow({ where: key });
  await handlePlaidWebhook({
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    item_id: item.plaidItemId,
  });
  const rerun = await retryWithBackoff(
    () => prisma.integrationSyncProgress.findUnique({ where: key }),
    {
      maxRetries: 60,
      fixedDelays: Array.from({ length: 60 }, () => 500),
      shouldRetryResult: (row) =>
        row === null || row.runId === before.runId || row.finishedAt === null,
      component: 'PlaidProgressWebhookWait',
    }
  );
  assert(rerun !== null && rerun.runId !== before.runId, 'the webhook started a new sync run');
  assert(rerun.retiredRunIds.includes(before.runId), 'the previous run is retired');
  const newlySaved = (await savedTransactions(item.id)) - savedBefore;
  assert(newlySaved > 0, `the sandbox Item delivered real transactions, got ${newlySaved}`);
  // The run counts every transaction it applied. When the exchange-time run
  // already saved part of the history, Plaid re-sends those rows as
  // modifications alongside the new additions, so count rows the run touched.
  const expected = await prisma.plaidTransaction.count({
    where: { plaidItemId: item.id, updatedAt: { gte: rerun.startedAt } },
  });
  const rows = await prisma.integrationSyncProgress.count({ where: { userId, provider: 'plaid' } });
  assert(rows === 1, `one progress row for the plaid row, got ${rows}`);
  const after = await plaidBar(ctx, accessToken);
  assert(after.state === 'synced', `synced after the webhook re-sync, got ${after.state}`);
  assert(
    after.progress?.done === expected,
    `done = ${expected} transactions saved, got ${after.progress?.done}`
  );
}

export function cases(ctx: PlaidSuiteContext): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    {
      name: 'sync progress: the plaid row bar after exchange and after a webhook re-sync',
      fn: () => sandboxProgress(ctx),
    },
  ];
}
