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
  findPlaidItemForUser,
  markIntegrationDisconnected,
  markPlaidItemDisconnected,
  persistPlaidItem,
  PlaidItemStatus,
  type PlaidItemWithAccounts,
} from './repo.plaid';

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

export interface CreatedLinkToken {
  link_token: string;
  expiration: string;
  request_id: string;
}

export interface PublicTokenExchangeResult {
  item: SerializedPlaidItem;
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

export async function exchangePlaidPublicToken(
  userId: string,
  input: {
    publicToken: string;
    institutionId?: string;
    institutionName?: string;
  }
): Promise<PublicTokenExchangeResult> {
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

  return { item: serializeItem(item) };
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
