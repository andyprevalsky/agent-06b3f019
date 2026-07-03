/* eslint-disable max-lines */
/**
 * Plaid integration service.
 *
 * Implements the Rose Labs side of the Plaid Link lifecycle:
 *   1. Create a Link token for the user (server-side, scoped to their userId)
 *   2. Exchange a public_token from the front-end for a long-lived access_token,
 *      encrypt it via app-layer envelope encryption, and persist a PlaidItem +
 *      per-account PlaidAccount rows
 *   3. List the user's connected Items + accounts
 *   4. Disconnect an Item: revoke at Plaid via /item/remove, mark local rows
 *      DISCONNECTED, and flip the parent Integration row to NOT_CONNECTED
 *
 * Access tokens are encrypted at the application layer using AES-256-GCM with
 * RSA-OAEP-SHA256 envelope encryption before they touch the database (see
 * providers/plaidCredentials.ts).
 */

import { createLogger } from '../../providers/logger';
import {
  createLinkToken,
  exchangePublicToken,
  getAccounts,
  removeItem,
  isPlaidError,
} from '../../providers/plaid';
import {
  encryptPlaidAccessToken,
  decryptPlaidAccessTokenOrThrow,
} from '../../providers/plaidCredentials';
import {
  countActivePlaidItems,
  findActivePlaidItemsForUser,
  findActivePlaidItemsWithAccountsForUser,
  findPlaidItemForUser,
  findPlaidItemWithAccountsForUser,
  markIntegrationDisconnected,
  markPlaidItemDisconnected,
  persistPlaidItem,
  PlaidItemStatus,
  type PlaidItemWithAccounts,
} from './repo.plaid';
import { syncPlaidItemTransactions } from './service.plaidTransactions';

const log = createLogger('PlaidService');

export class PlaidItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`Plaid item ${itemId} not found for this user`);
    this.name = 'PlaidItemNotFoundError';
  }
}

export class PlaidApiError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly errorType: string,
    message: string
  ) {
    super(message);
    this.name = 'PlaidApiError';
  }
}

export class PlaidDuplicateItemError extends Error {
  constructor(message = 'This financial institution account is already connected') {
    super(message);
    this.name = 'PlaidDuplicateItemError';
  }
}

export interface CreatedLinkToken {
  link_token: string;
  expiration: string;
  request_id: string;
}

export interface PublicTokenExchangeResult {
  item: SerializedPlaidItem;
}

export interface PlaidLinkMetadataAccount {
  name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
}

export interface SerializedPlaidAccount {
  id: string;
  plaidAccountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
}

export interface SerializedPlaidItem {
  id: string;
  plaidItemId: string;
  institutionId: string | null;
  institutionName: string | null;
  status: PlaidItemStatus;
  products: string[];
  createdAt: string;
  lastSyncAt: string | null;
  disconnectedAt: string | null;
  accounts: SerializedPlaidAccount[];
}

function toApiError(err: unknown, context: string): never {
  if (isPlaidError(err)) {
    log.error(`Plaid API error during ${context}`, {
      code: err.response.data.error_code,
      type: err.response.data.error_type,
      message: err.response.data.error_message,
    });
    throw new PlaidApiError(
      err.response.data.error_code,
      err.response.data.error_type,
      err.response.data.error_message
    );
  }
  throw err;
}

export async function createPlaidLinkToken(userId: string): Promise<CreatedLinkToken> {
  try {
    const data = await createLinkToken({ clientUserId: userId });
    log.info('Created Plaid link token', { userId, expiration: data.expiration });
    return {
      link_token: data.link_token,
      expiration: data.expiration,
      request_id: data.request_id,
    };
  } catch (err) {
    toApiError(err, 'createLinkToken');
  }
}

export async function createPlaidUpdateLinkToken(
  userId: string,
  itemRowId: string
): Promise<CreatedLinkToken> {
  const item = await findPlaidItemForUser(userId, itemRowId);
  if (!item) throw new PlaidItemNotFoundError(itemRowId);

  try {
    const accessToken = decryptPlaidAccessTokenOrThrow(item.encryptedAccessToken);
    const data = await createLinkToken({ clientUserId: userId, accessToken });
    log.info('Created Plaid update-mode link token', { userId, itemRowId });
    return {
      link_token: data.link_token,
      expiration: data.expiration,
      request_id: data.request_id,
    };
  } catch (err) {
    toApiError(err, 'createUpdateLinkToken');
  }
}

function accountLooksDuplicate(
  candidate: PlaidLinkMetadataAccount,
  existing: { name: string; mask: string | null; type: string; subtype: string | null }
): boolean {
  const nameMatches =
    typeof candidate.name === 'string' &&
    candidate.name.trim().toLowerCase() === existing.name.trim().toLowerCase();
  const maskMatches =
    candidate.mask !== undefined &&
    candidate.mask !== null &&
    existing.mask !== null &&
    candidate.mask === existing.mask;
  const typeMatches =
    candidate.type !== undefined && candidate.type !== null && candidate.type === existing.type;
  const subtypeMatches =
    (candidate.subtype ?? null) === existing.subtype || candidate.subtype === undefined;
  return nameMatches && maskMatches && typeMatches && subtypeMatches;
}

async function assertNotDuplicatePlaidItem(
  userId: string,
  input: {
    institutionId?: string;
    accounts?: PlaidLinkMetadataAccount[];
  }
): Promise<void> {
  if (
    input.institutionId === undefined ||
    input.institutionId === '' ||
    input.accounts === undefined ||
    input.accounts.length === 0
  ) {
    return;
  }
  const existingItems = await findActivePlaidItemsWithAccountsForUser(userId);
  const institutionMatches = existingItems.filter(
    (item) => item.plaidInstitutionId === input.institutionId
  );
  for (const item of institutionMatches) {
    for (const candidate of input.accounts) {
      if (item.accounts.some((existing) => accountLooksDuplicate(candidate, existing))) {
        throw new PlaidDuplicateItemError(
          `${item.institutionName ?? 'This institution'} account is already connected`
        );
      }
    }
  }
}

export async function exchangePlaidPublicToken(
  userId: string,
  input: {
    publicToken: string;
    institutionId?: string;
    institutionName?: string;
    accounts?: PlaidLinkMetadataAccount[];
  }
): Promise<PublicTokenExchangeResult> {
  await assertNotDuplicatePlaidItem(userId, input);

  let accessToken: string;
  let plaidItemId: string;
  try {
    const exchange = await exchangePublicToken(input.publicToken);
    accessToken = exchange.access_token;
    plaidItemId = exchange.item_id;
  } catch (err) {
    return toApiError(err, 'exchangePublicToken');
  }

  let accountsResponse: Awaited<ReturnType<typeof getAccounts>>;
  try {
    accountsResponse = await getAccounts(accessToken);
  } catch (err) {
    return toApiError(err, 'accountsGet');
  }

  const encryptedAccessToken = encryptPlaidAccessToken(accessToken);

  const item = await persistPlaidItem(
    userId,
    {
      plaidItemId,
      encryptedAccessToken,
      institutionId: input.institutionId,
      institutionName: input.institutionName,
    },
    accountsResponse.accounts
  );

  log.info('Exchanged Plaid public token', {
    userId,
    plaidItemId,
    accounts: item.accounts.length,
  });

  try {
    await syncPlaidItemTransactions(item.id);
  } catch (err) {
    log.warn('Initial Plaid transaction sync did not complete after token exchange', {
      userId,
      plaidItemId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { item: serializeItem(item) };
}

export async function completePlaidUpdateMode(
  userId: string,
  itemRowId: string
): Promise<PublicTokenExchangeResult> {
  const item = await findPlaidItemWithAccountsForUser(userId, itemRowId);
  if (!item) throw new PlaidItemNotFoundError(itemRowId);

  try {
    await syncPlaidItemTransactions(item.id);
  } catch (err) {
    log.warn('Plaid update-mode completion sync did not complete', {
      userId,
      itemRowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const updated = await findPlaidItemWithAccountsForUser(userId, itemRowId);
  if (!updated) throw new PlaidItemNotFoundError(itemRowId);
  return { item: serializeItem(updated) };
}

export async function listPlaidItems(userId: string): Promise<SerializedPlaidItem[]> {
  const items = await findActivePlaidItemsForUser(userId);
  return items.map(serializeItem);
}

async function revokePlaidItemAtProvider(
  userId: string,
  plaidItemId: string,
  encryptedAccessToken: string
): Promise<void> {
  try {
    const accessToken = decryptPlaidAccessTokenOrThrow(encryptedAccessToken);
    await removeItem(accessToken);
  } catch (err) {
    if (isPlaidError(err)) {
      log.warn('Plaid /item/remove rejected; proceeding with local disconnect', {
        userId,
        plaidItemId,
        code: err.response.data.error_code,
      });
    } else {
      log.error('Unexpected error during /item/remove', {
        userId,
        plaidItemId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function disconnectPlaidItem(
  userId: string,
  plaidItemId: string
): Promise<{ ok: true }> {
  const item = await findPlaidItemForUser(userId, plaidItemId);
  if (!item) {
    throw new PlaidItemNotFoundError(plaidItemId);
  }

  if (item.status !== PlaidItemStatus.DISCONNECTED) {
    await revokePlaidItemAtProvider(userId, plaidItemId, item.encryptedAccessToken);
  }

  await markPlaidItemDisconnected(item.id);

  const remaining = await countActivePlaidItems(userId, item.integrationId);
  if (remaining === 0) {
    await markIntegrationDisconnected(item.integrationId);
  }

  log.info('Disconnected Plaid item', { userId, plaidItemId });
  return { ok: true };
}

export async function disconnectAllPlaidItems(
  userId: string
): Promise<{ ok: true; disconnected: number }> {
  const items = await findActivePlaidItemsForUser(userId);
  let disconnected = 0;
  for (const item of items) {
    await disconnectPlaidItem(userId, item.id);
    disconnected += 1;
  }
  return { ok: true, disconnected };
}

function serializeItem(item: PlaidItemWithAccounts): SerializedPlaidItem {
  return {
    id: item.id,
    plaidItemId: item.plaidItemId,
    institutionId: item.plaidInstitutionId,
    institutionName: item.institutionName,
    status: item.status,
    products: item.products,
    createdAt: item.createdAt.toISOString(),
    lastSyncAt: item.lastSyncAt ? item.lastSyncAt.toISOString() : null,
    disconnectedAt: item.disconnectedAt ? item.disconnectedAt.toISOString() : null,
    accounts: item.accounts.map((a) => ({
      id: a.id,
      plaidAccountId: a.plaidAccountId,
      name: a.name,
      officialName: a.officialName,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
    })),
  };
}
