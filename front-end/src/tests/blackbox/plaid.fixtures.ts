/**
 * Shared fixtures and harness for the Plaid blackbox tests.
 *
 * Extracted so the spec files stay focused on assertions and none of them has
 * to carry the item/sync builders past the max-lines budget. The rendered
 * harness lives in plaid.harness.tsx (component-only module for
 * react-refresh/only-export-components).
 */

import type { PlaidItem, PlaidSyncSummary } from '@/features/integrations/types';

export const API_BASE = 'http://localhost:3001/api';

export function mockSession(): void {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

export function makeSync(overrides: Partial<PlaidSyncSummary> = {}): PlaidSyncSummary {
  return {
    transactionCount: 42,
    postedTransactionCount: 40,
    pendingTransactionCount: 2,
    removedTransactionCount: 0,
    dateRange: {
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-03-31T00:00:00.000Z',
    },
    ...overrides,
  };
}

export function makeItem(overrides: Partial<PlaidItem> = {}): PlaidItem {
  return {
    id: 'item-uuid-1',
    plaidItemId: 'plaid_item_1',
    institutionId: 'ins_109508',
    institutionName: 'First Platypus Bank',
    status: 'ACTIVE',
    products: ['transactions', 'auth'],
    createdAt: '2026-05-12T17:00:00Z',
    lastSyncAt: '2026-05-12T17:00:00Z',
    disconnectedAt: null,
    sync: {
      ...makeSync(),
      state: 'synced',
    },
    accounts: [
      {
        id: 'acct-uuid-1',
        plaidAccountId: 'acct_plaid_1',
        name: 'Plaid Checking',
        officialName: 'Plaid Gold Checking',
        mask: '0000',
        type: 'depository',
        subtype: 'checking',
        sync: makeSync(),
      },
    ],
    ...overrides,
  };
}
