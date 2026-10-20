/**
 * Plaid webhook handling.
 *
 * Verifies Plaid's signed JWT, then handles webhooks as signals to refresh
 * local state. Heavy work is intentionally outside the HTTP response path.
 */

import { createHash, createPublicKey, timingSafeEqual } from '../../providers/crypto';
import { decodeJwt, verifyJwt } from '../../providers/jwt';
import { createLogger } from '../../providers/logger';
import { getWebhookVerificationKey } from '../../providers/plaid';
import { PLAID_SKIP_WEBHOOK_VERIFICATION } from './config';
import { findPlaidItemByPlaidItemId, markPlaidItemSyncFailed } from './repo.plaid';
import { syncPlaidTransactionsByPlaidItemId } from './service.plaidTransactions';

const log = createLogger('PlaidWebhooks');
const WEBHOOK_JWT_MAX_AGE_SECONDS = 300;

export class PlaidWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaidWebhookVerificationError';
  }
}

export interface PlaidWebhookPayload {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  error?: {
    error_code?: string;
    error_message?: string;
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function verifyPlaidWebhook(
  rawBody: string,
  verificationHeader: unknown
): Promise<void> {
  if (PLAID_SKIP_WEBHOOK_VERIFICATION) return;
  if (typeof verificationHeader !== 'string' || verificationHeader.trim() === '') {
    throw new PlaidWebhookVerificationError('Missing Plaid-Verification header');
  }

  const decoded = decodeJwt(verificationHeader, { complete: true });
  if (!decoded || typeof decoded !== 'object' || typeof decoded.header.kid !== 'string') {
    throw new PlaidWebhookVerificationError('Invalid Plaid webhook JWT header');
  }
  if (decoded.header.alg !== 'ES256') {
    throw new PlaidWebhookVerificationError('Invalid Plaid webhook JWT algorithm');
  }

  const verificationKey = await getWebhookVerificationKey(decoded.header.kid);
  const publicKeyInput = {
    key: verificationKey.key as unknown as Record<string, unknown>,
    format: 'jwk',
  } as Parameters<typeof createPublicKey>[0];
  const publicKey = createPublicKey(publicKeyInput);
  const claims = verifyJwt(verificationHeader, publicKey, { algorithms: ['ES256'] }) as {
    iat?: number;
    request_body_sha256?: string;
  };
  if (
    typeof claims.iat !== 'number' ||
    Date.now() / 1000 - claims.iat > WEBHOOK_JWT_MAX_AGE_SECONDS
  ) {
    throw new PlaidWebhookVerificationError('Expired Plaid webhook JWT');
  }
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  if (
    typeof claims.request_body_sha256 !== 'string' ||
    !constantTimeEqual(bodyHash, claims.request_body_sha256)
  ) {
    throw new PlaidWebhookVerificationError('Plaid webhook body hash mismatch');
  }
}

async function markItemNeedsUpdateMode(payload: PlaidWebhookPayload): Promise<void> {
  if (payload.item_id === undefined || payload.item_id === '') return;
  const item = await findPlaidItemByPlaidItemId(payload.item_id);
  if (!item) return;
  await markPlaidItemSyncFailed(
    item.id,
    payload.error?.error_code ?? payload.webhook_code ?? 'ITEM_REQUIRES_UPDATE',
    payload.error?.error_message ?? 'Plaid Item requires user update mode'
  );
}

export async function handlePlaidWebhook(payload: PlaidWebhookPayload): Promise<{ ok: true }> {
  log.info('Plaid webhook received', {
    type: payload.webhook_type,
    code: payload.webhook_code,
    itemId: payload.item_id,
  });

  if (payload.item_id === undefined || payload.item_id === '') return { ok: true };

  if (payload.webhook_type === 'TRANSACTIONS') {
    void syncPlaidTransactionsByPlaidItemId(payload.item_id, { webhookAt: new Date() }).catch(
      (err) => {
        log.error('Plaid webhook-triggered transaction sync failed', {
          itemId: payload.item_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    );
    return { ok: true };
  }

  if (
    payload.webhook_type === 'ITEM' &&
    ['ERROR', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT'].includes(payload.webhook_code ?? '')
  ) {
    await markItemNeedsUpdateMode(payload);
  }

  if (payload.webhook_type === 'ITEM' && payload.webhook_code === 'LOGIN_REPAIRED') {
    void syncPlaidTransactionsByPlaidItemId(payload.item_id, { webhookAt: new Date() }).catch(
      (err) => {
        log.error('Plaid LOGIN_REPAIRED sync failed', {
          itemId: payload.item_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    );
  }

  return { ok: true };
}
