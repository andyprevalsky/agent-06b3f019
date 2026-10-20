/**
 * plaid blackbox: per-Item sync progress against the live Plaid Sandbox (plan row I5).
 *
 *   mint + exchange (backend) ─► exchange-time sync ─► chip (Plaid usually NOT_READY)
 *   Plaid history ready ─► TRANSACTIONS webhook handler ─► same row, new run, real count
 *   /sandbox/item/reset_login ─► update-complete (backend) ─► ITEM_LOGIN_REQUIRED
 *        ─► only that Item reads needs_reconnect
 *
 * Deterministic page-level cases (indeterminate totals, coalescing, independent
 * Items) live in integration-accounts.plaid.cases.ts. Registered by
 * plaid.blackbox.ts, which supplies its sandbox client and request helpers.
 */
import { z } from 'zod';
import type { PlaidApi } from 'plaid';
import { prisma } from '../../providers/database';
import { syncTransactions } from '../../providers/plaid';
import { decryptPlaidAccessTokenOrThrow } from '../../providers/plaidCredentials';
import { retryWithBackoff } from '../../providers/retry';
import { handlePlaidWebhook } from '../../domains/integrations/service.plaidWebhooks';
import { assert, ListResponse, type Account } from './integration-accounts.support';

export interface PlaidSuiteContext {
  baseUrl: string;
  sandboxClient: PlaidApi;
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

async function plaidChips(ctx: PlaidSuiteContext, accessToken: string) {
  const res = await ctx.request(`${ctx.baseUrl}/api/integrations`, {
    headers: ctx.authHeaders(accessToken),
  });
  expectStatus(res, 200, 'GET /api/integrations');
  const accounts = ListResponse.parse(res.data).accountsByProvider.plaid ?? [];
  return new Map(accounts.map((account) => [account.accountId, account]));
}

function assertSyncedChip(account: Account | undefined, label: string, count?: number): void {
  assert(account !== undefined, `${label}: the Item is listed as a plaid account`);
  assert(account.state === 'synced', `${label}: synced, got ${account.state}`);
  assert(account.progress.unit === 'transactions', `${label}: counted in transactions`);
  assert(
    typeof account.progress.done === 'number' && account.progress.total === account.progress.done,
    `${label}: final counts, got ${JSON.stringify(account.progress)}`
  );
  assert(
    count === undefined || account.progress.done === count,
    `${label}: done ${String(count)} (transactions saved), got ${account.progress.done}`
  );
}

/**
 * Right after Link, Plaid is usually still preparing the Item (NOT_READY), so
 * the exchange-time run stays syncing with an unknown total; if Plaid was
 * already ready it is synced with its counts. Never synced with a fake total.
 */
function assertExchangeChip(account: Account | undefined, label: string): void {
  if (account?.state === 'synced') {
    assertSyncedChip(account, label);
    return;
  }
  assert(
    account?.state === 'syncing' &&
      account.progress.phase === 'waiting_for_plaid' &&
      account.progress.total === null &&
      account.progress.pct === null &&
      account.progress.unit === 'transactions',
    `${label}: syncing while Plaid prepares the Item, got ${JSON.stringify(account)}`
  );
}

/**
 * Polls Plaid (with the production /transactions/sync request, from no cursor,
 * so the stored cursor is untouched) until the Item's history is ready — the
 * moment Plaid would send its SYNC_UPDATES_AVAILABLE historical-update webhook.
 */
async function waitForPlaidHistory(ctx: PlaidSuiteContext, accessToken: string): Promise<void> {
  const page = await retryWithBackoff(() => syncTransactions(accessToken, null), {
    maxRetries: 40,
    fixedDelays: Array.from({ length: 40 }, () => 1_000),
    isRetryable: ctx.isRetryablePlaidSandboxError,
    shouldRetryResult: (res) => res.transactions_update_status !== 'HISTORICAL_UPDATE_COMPLETE',
    component: 'PlaidSandboxHistoryWait',
  });
  assert(
    page.transactions_update_status === 'HISTORICAL_UPDATE_COMPLETE',
    `sandbox history ready, got ${page.transactions_update_status}`
  );
}

const savedTransactions = (plaidItemId: string) =>
  prisma.plaidTransaction.count({ where: { plaidItemId, removedAt: null } });

async function perItemSandboxProgress(ctx: PlaidSuiteContext): Promise<void> {
  const { accessToken, userId } = await ctx.createAnonSession();
  const first = await exchangeSandboxItem(ctx, accessToken);
  const second = await exchangeSandboxItem(ctx, accessToken);
  let chips = await plaidChips(ctx, accessToken);
  assert(chips.size === 2, `two Items are two plaid accounts, got ${chips.size}`);
  assertExchangeChip(chips.get(first.id), 'first Item after exchange');
  assertExchangeChip(chips.get(second.id), 'second Item after exchange');

  const key = (accountId: string) => ({
    userId_provider_accountId: { userId, provider: 'plaid', accountId },
  });
  const tokenOf = async (itemRowId: string) =>
    decryptPlaidAccessTokenOrThrow(
      (await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemRowId } })).encryptedAccessToken
    );
  await waitForPlaidHistory(ctx, await tokenOf(first.id));
  const savedBefore = await savedTransactions(first.id);
  const before = await prisma.integrationSyncProgress.findUniqueOrThrow({ where: key(first.id) });
  await handlePlaidWebhook({
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    item_id: first.plaidItemId,
  });
  const rerun = await retryWithBackoff(
    () => prisma.integrationSyncProgress.findUnique({ where: key(first.id) }),
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
  // Plaid's history arrives as additions, so the run's count is what it newly saved.
  const expected = (await savedTransactions(first.id)) - savedBefore;
  assert(expected > 0, `the sandbox Item delivered real transactions, got ${expected}`);
  const rows = await prisma.integrationSyncProgress.count({ where: { userId, provider: 'plaid' } });
  assert(rows === 2, `one progress row per Item after the webhook, got ${rows}`);
  chips = await plaidChips(ctx, accessToken);
  assert(chips.size === 2, `the webhook re-sync created no duplicate account, got ${chips.size}`);
  assertSyncedChip(chips.get(first.id), 'first Item after the webhook re-sync', expected);

  await ctx.sandboxClient.sandboxItemResetLogin({ access_token: await tokenOf(second.id) });
  const repair = await ctx.request(
    `${ctx.baseUrl}/api/integrations/plaid/items/${second.id}/update-complete`,
    { method: 'POST', headers: ctx.authHeaders(accessToken) }
  );
  expectStatus(repair, 200, 'update-complete after reset_login');
  chips = await plaidChips(ctx, accessToken);
  const broken = chips.get(second.id);
  assert(
    broken?.state === 'needs_reconnect',
    `ITEM_LOGIN_REQUIRED reads needs_reconnect, got ${JSON.stringify(broken)}`
  );
  const brokenRow = await prisma.integrationSyncProgress.findUniqueOrThrow({
    where: key(second.id),
  });
  assert(
    brokenRow.state === 'needs_reconnect',
    `sync recorded needs_reconnect: ${brokenRow.state}`
  );
  assertSyncedChip(chips.get(first.id), 'the other Item stays synced', expected);
}

export function cases(ctx: PlaidSuiteContext): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    {
      name: 'sync progress: per-Item chips, webhook re-sync reuses the row, reset_login reconnects',
      fn: () => perItemSandboxProgress(ctx),
    },
  ];
}
