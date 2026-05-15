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
 * providers/plaidCredentials.ts). This matches the commitment made in the
 * Rose Labs Information Security Policy §7 and Privacy Policy §3.
 */

import {
  IntegrationStatus,
  IntegrationType,
  PlaidItemStatus,
  type PlaidAccount,
  type PlaidItem,
} from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import {
  createLinkToken,
  exchangePublicToken,
  getAccounts,
  removeItem,
  isPlaidError,
  PLAID_DEFAULT_PRODUCTS,
} from '../../providers/plaid';
import {
  encryptPlaidAccessToken,
  decryptPlaidAccessTokenOrThrow,
} from '../../providers/plaidCredentials';

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
    message: string,
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
      err.response.data.error_message,
    );
  }
  throw err;
}

/**
 * Create a Plaid Link token for the given user. The Link token is short-lived
 * (Plaid defaults to ~4 hours) and is consumed once by the front-end Link
 * client.
 */
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

/**
 * Exchange the front-end's `public_token` for a long-lived `access_token`,
 * encrypt it, and persist a PlaidItem (+ accounts) for the user.
 *
 * Idempotent on plaid_item_id: if the user already has a PlaidItem with the
 * same plaidItemId (e.g., they re-connected the same institution), the
 * existing row is updated rather than duplicated.
 */
export async function exchangePlaidPublicToken(
  userId: string,
  input: {
    publicToken: string;
    institutionId?: string;
    institutionName?: string;
  },
): Promise<PublicTokenExchangeResult> {
  // Exchange + fetch accounts in two Plaid calls (Plaid does not return
  // accounts in the exchange response).
  let accessToken: string;
  let plaidItemId: string;
  try {
    const exchange = await exchangePublicToken(input.publicToken);
    accessToken = exchange.access_token;
    plaidItemId = exchange.item_id;
  } catch (err) {
    return toApiError(err, 'exchangePublicToken');
  }

  let accountsResponse;
  try {
    accountsResponse = await getAccounts(accessToken);
  } catch (err) {
    return toApiError(err, 'accountsGet');
  }

  const encryptedAccessToken = encryptPlaidAccessToken(accessToken);

  // Upsert the parent Integration row + the PlaidItem + each PlaidAccount in
  // a single transaction so partial failures don't leave orphan rows.
  const item = await prisma.$transaction(async (tx) => {
    const integration = await tx.integration.upsert({
      where: { userId_name: { userId, name: 'plaid' } },
      create: {
        userId,
        type: IntegrationType.DATA_SOURCE,
        name: 'plaid',
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        lastSyncAt: new Date(),
      },
      update: {
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        lastSyncAt: new Date(),
        failureReason: null,
      },
    });

    const plaidItem = await tx.plaidItem.upsert({
      where: { plaidItemId },
      create: {
        userId,
        integrationId: integration.id,
        plaidItemId,
        plaidInstitutionId: input.institutionId ?? null,
        institutionName: input.institutionName ?? null,
        encryptedAccessToken,
        status: PlaidItemStatus.ACTIVE,
        products: PLAID_DEFAULT_PRODUCTS,
        lastSyncAt: new Date(),
      },
      update: {
        encryptedAccessToken,
        plaidInstitutionId: input.institutionId ?? null,
        institutionName: input.institutionName ?? null,
        status: PlaidItemStatus.ACTIVE,
        disconnectedAt: null,
        errorCode: null,
        errorMessage: null,
        lastSyncAt: new Date(),
      },
    });

    // Upsert accounts: Plaid account_ids are stable per item.
    await Promise.all(
      accountsResponse.accounts.map((acct) =>
        tx.plaidAccount.upsert({
          where: { plaidAccountId: acct.account_id },
          create: {
            userId,
            plaidItemId: plaidItem.id,
            plaidAccountId: acct.account_id,
            name: acct.name,
            officialName: acct.official_name ?? null,
            mask: acct.mask ?? null,
            type: acct.type,
            subtype: acct.subtype ?? null,
            verificationStatus: acct.verification_status ?? null,
          },
          update: {
            name: acct.name,
            officialName: acct.official_name ?? null,
            mask: acct.mask ?? null,
            type: acct.type,
            subtype: acct.subtype ?? null,
            verificationStatus: acct.verification_status ?? null,
            disconnectedAt: null,
          },
        }),
      ),
    );

    const updated = await tx.plaidItem.findUnique({
      where: { id: plaidItem.id },
      include: { accounts: true },
    });
    if (!updated) throw new Error('PlaidItem disappeared mid-transaction');
    return updated;
  });

  log.info('Exchanged Plaid public token', {
    userId,
    plaidItemId,
    accounts: item.accounts.length,
  });

  return { item: serializeItem(item) };
}

export async function listPlaidItems(userId: string): Promise<SerializedPlaidItem[]> {
  const items = await prisma.plaidItem.findMany({
    where: { userId, status: { not: PlaidItemStatus.DISCONNECTED } },
    include: { accounts: { where: { disconnectedAt: null } } },
    orderBy: { createdAt: 'asc' },
  });
  return items.map(serializeItem);
}

export async function disconnectPlaidItem(
  userId: string,
  plaidItemId: string,
): Promise<{ ok: true }> {
  const item = await prisma.plaidItem.findFirst({
    where: { id: plaidItemId, userId },
  });
  if (!item) {
    throw new PlaidItemNotFoundError(plaidItemId);
  }

  if (item.status !== PlaidItemStatus.DISCONNECTED) {
    try {
      const accessToken = decryptPlaidAccessTokenOrThrow(item.encryptedAccessToken);
      await removeItem(accessToken);
    } catch (err) {
      // We want disconnection to succeed locally even if Plaid 4xx-rejects the
      // /item/remove call (e.g., token already revoked). Log and proceed.
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

  const now = new Date();
  await prisma.$transaction([
    prisma.plaidAccount.updateMany({
      where: { plaidItemId: item.id, disconnectedAt: null },
      data: { disconnectedAt: now },
    }),
    prisma.plaidItem.update({
      where: { id: item.id },
      data: { status: PlaidItemStatus.DISCONNECTED, disconnectedAt: now },
    }),
  ]);

  // If this was the user's last active Plaid item, flip the parent Integration
  // row to NOT_CONNECTED so the Integrations list mirrors the truth.
  const remaining = await prisma.plaidItem.count({
    where: {
      userId,
      integrationId: item.integrationId,
      status: { not: PlaidItemStatus.DISCONNECTED },
    },
  });
  if (remaining === 0) {
    await prisma.integration.update({
      where: { id: item.integrationId },
      data: { status: IntegrationStatus.NOT_CONNECTED, isActive: false },
    });
  }

  log.info('Disconnected Plaid item', { userId, plaidItemId });
  return { ok: true };
}

function serializeItem(item: PlaidItem & { accounts: PlaidAccount[] }): SerializedPlaidItem {
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
