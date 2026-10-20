/**
 * Plaid sync reads keyed by one Item.
 *
 * A sync used to load every syncable Item of every user and pick one in
 * memory; this is the single-row lookup by primary key (10k rule: a webhook or
 * exchange sync costs one indexed read, not a scan of all Items).
 */

import type { PlaidItem } from '@prisma/client';
import { prisma } from '../../providers/database';
import { PlaidItemStatus, REDACTED_PLAID_ACCESS_TOKEN } from './repo.plaid';

/** The Item when it can still sync: not disconnected and its token not redacted. */
export async function findSyncablePlaidItem(itemRowId: string): Promise<PlaidItem | null> {
  return prisma.plaidItem.findFirst({
    where: {
      id: itemRowId,
      status: { not: PlaidItemStatus.DISCONNECTED },
      encryptedAccessToken: { not: REDACTED_PLAID_ACCESS_TOKEN },
    },
  });
}
