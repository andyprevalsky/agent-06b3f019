import { TestPaymentError } from './errors';
import { mcpResultRows } from './lifecycleProviderRecords';
import type {
  OrgTransferStatus,
  StripeHoldSearch,
  TestPaymentLifecycleDependencies,
} from './lifecycleDependencies';

const PROVIDER_PAGE_SIZE = 100;
const MAX_PROVIDER_PAGES = 100;
const PROVIDER_PURCHASE_WINDOW_SKEW_MS = 5_000;
const ORG_TRANSFER_STATUSES: OrgTransferStatus[] = [
  'pending',
  'funded',
  'consumed',
  'reclaimed',
  'failed',
];

function providerRows(result: unknown, field: string): Record<string, unknown>[] {
  return mcpResultRows(result, field);
}

function providerCreatedAt(row: Record<string, unknown>, field: string): number | null {
  const value = row[field];
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowCovered(
  rows: Record<string, unknown>[],
  createdAtField: string,
  purchaseCreatedAt: Date
): boolean {
  if (rows.length < PROVIDER_PAGE_SIZE) return true;
  const timestamps = rows.map((row) => providerCreatedAt(row, createdAtField));
  if (timestamps.some((value) => value === null)) return false;
  const oldest = Math.min(...(timestamps as number[]));
  return oldest <= purchaseCreatedAt.getTime() - PROVIDER_PURCHASE_WINDOW_SKEW_MS;
}

export async function listOrgCardWindow(
  cardholderId: string,
  purchaseCreatedAt: Date,
  listOrgCards: Required<TestPaymentLifecycleDependencies>['listOrgCards']
): Promise<unknown[]> {
  const results: unknown[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
    const result = await listOrgCards({
      cardholder_id: cardholderId,
      limit: PROVIDER_PAGE_SIZE,
      ...(offset > 0 ? { offset } : {}),
    });
    results.push(result);
    const rows = providerRows(result, 'cards');
    if (windowCovered(rows, 'createdAt', purchaseCreatedAt)) return results;
    if (rows.length !== PROVIDER_PAGE_SIZE) {
      throw new TestPaymentError('AgentCard card history could not prove purchase coverage', 502);
    }
    offset += rows.length;
  }
  throw new TestPaymentError('AgentCard card history exceeded lifecycle pagination limit', 502);
}

export async function listOrgTransferWindow(
  purchaseCreatedAt: Date,
  listOrgTransfers: Required<TestPaymentLifecycleDependencies>['listOrgTransfers']
): Promise<unknown[]> {
  const results = await Promise.all(
    ORG_TRANSFER_STATUSES.map((status) =>
      listOrgTransfers({ status, limit: PROVIDER_PAGE_SIZE }).then((result) => ({
        status,
        result,
      }))
    )
  );
  for (const { status, result } of results) {
    const rows = providerRows(result, 'transfers');
    // AgentCard's live list_transfers schema has no offset/cursor. A full page newer than the
    // purchase means an older matching or unlinked transfer could be hidden. Fail the proof
    // closed instead of reporting a false zero-orphan result.
    if (!windowCovered(rows, 'created_at', purchaseCreatedAt)) {
      throw new TestPaymentError(
        `AgentCard ${status} transfer history does not cover the purchase window`,
        502
      );
    }
  }
  return results.map(({ result }) => result);
}

export async function searchAllStripeHolds(
  agentId: string,
  searchStripeHolds: Required<TestPaymentLifecycleDependencies>['searchStripeHolds']
): Promise<StripeHoldSearch> {
  const byId = new Map<string, { id: string }>();
  const seenPages = new Set<string>();
  let page: string | undefined;
  for (let attempt = 0; attempt < MAX_PROVIDER_PAGES; attempt += 1) {
    const result = await searchStripeHolds(agentId, page);
    if (!Array.isArray(result.data)) {
      throw new TestPaymentError('Stripe payment history response was invalid', 502);
    }
    for (const intent of result.data) {
      if (typeof intent?.id !== 'string' || intent.id.trim() === '') {
        throw new TestPaymentError('Stripe payment history contained an invalid intent id', 502);
      }
      byId.set(intent.id, intent);
    }
    if (result.has_more !== true) return { data: [...byId.values()] };
    const nextPage = result.next_page;
    if (typeof nextPage !== 'string' || nextPage === '' || seenPages.has(nextPage)) {
      throw new TestPaymentError('Stripe payment history pagination did not advance', 502);
    }
    seenPages.add(nextPage);
    page = nextPage;
  }
  throw new TestPaymentError('Stripe payment history exceeded lifecycle pagination limit', 502);
}
