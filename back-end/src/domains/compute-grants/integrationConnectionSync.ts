/**
 * Keeps ComputeAccountConnection chips aligned with Integration auth health.
 *
 * Runtime tokens live on Integration rows; the FE chips read
 * ComputeAccountConnection.state. Without an explicit bridge, an Integration can
 * be EXPIRED/auth_error while its chip still shows "connected".
 *
 * Rate limits are intentionally excluded: a throttled token is healthy and should
 * retry later, not prompt re-consent.
 */

import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';

const log = createLogger('IntegrationConnectionSync');

/** Observed in prod/local DB + markComputeTokenUnavailable / Claude Code paths. */
export const INTEGRATION_AUTH_FAILURE_REASONS = [
  'auth_error',
  'claude_code_auth_error',
] as const;

export type IntegrationAuthFailureReason = (typeof INTEGRATION_AUTH_FAILURE_REASONS)[number];

const AUTH_FAILURE_REASON_SET = new Set<string>(INTEGRATION_AUTH_FAILURE_REASONS);

export function isIntegrationAuthFailureReason(
  reason: string | null | undefined
): reason is IntegrationAuthFailureReason {
  return reason !== null && reason !== undefined && reason !== '' && AUTH_FAILURE_REASON_SET.has(reason);
}

export function integrationNameToProvider(name: string): 'claude' | 'codex' | null {
  if (name === 'claude_code') return 'claude';
  if (name === 'gpt_code') return 'codex';
  return null;
}

export async function markConnectionNeedsReconnectFromIntegrationFailure(params: {
  userId: string;
  integrationName: 'claude_code' | 'gpt_code';
  accountId?: string | null;
  failureReason: string;
}): Promise<void> {
  if (!isIntegrationAuthFailureReason(params.failureReason)) return;

  const provider = integrationNameToProvider(params.integrationName);
  if (provider === null) return;

  const accountId = params.accountId?.trim() ?? '';
  const where =
    accountId === ''
      ? { userId: params.userId, provider, state: 'connected' as const }
      : { userId: params.userId, provider, accountId };

  const result = await prisma.computeAccountConnection.updateMany({
    where,
    data: { state: 'needs_reconnect', lastErrorReason: params.failureReason },
  });

  if (result.count > 0) {
    log.info('connection.needs_reconnect_from_integration', {
      userId: params.userId,
      provider,
      accountId: accountId === '' ? '(legacy-all)' : accountId,
      failureReason: params.failureReason,
      updated: result.count,
    });
  }
}

export async function clearConnectionNeedsReconnectFromIntegrationRecovery(params: {
  userId: string;
  integrationName: 'claude_code' | 'gpt_code';
  accountId?: string | null;
}): Promise<void> {
  const provider = integrationNameToProvider(params.integrationName);
  if (provider === null) return;

  const accountId = params.accountId?.trim() ?? '';
  if (accountId === '') {
    // Legacy Integration rows (accountId="") cannot be mapped to a specific chip
    // in multi-account setups. Upload/connect paths may still heal broadly.
    return;
  }

  const result = await prisma.computeAccountConnection.updateMany({
    where: { userId: params.userId, provider, accountId, state: 'needs_reconnect' },
    data: { state: 'connected', lastErrorReason: null },
  });

  if (result.count > 0) {
    log.info('connection.healed_from_integration', {
      userId: params.userId,
      provider,
      accountId: accountId === '' ? '(legacy-all)' : accountId,
      updated: result.count,
    });
  }
}

/**
 * Repair chip drift for accounts whose Integration rows are permanently dead.
 * Called on chip list so historical failures surface without a migration.
 */
export async function reconcileConnectionStatesFromIntegrations(userId: string): Promise<void> {
  const failedIntegrations = await prisma.integration.findMany({
    where: {
      userId,
      name: { in: ['claude_code', 'gpt_code'] },
      status: 'EXPIRED',
      failureReason: { in: [...INTEGRATION_AUTH_FAILURE_REASONS] },
    },
    select: { name: true, accountId: true, failureReason: true },
  });

  await Promise.all(
    failedIntegrations.map((row) =>
      markConnectionNeedsReconnectFromIntegrationFailure({
        userId,
        integrationName: row.name as 'claude_code' | 'gpt_code',
        accountId: row.accountId,
        failureReason: row.failureReason as string,
      })
    )
  );

  const healthyIntegrations = await prisma.integration.findMany({
    where: {
      userId,
      name: { in: ['claude_code', 'gpt_code'] },
      status: 'CONNECTED',
      isActive: true,
      failureReason: null,
    },
    select: { name: true, accountId: true },
  });

  await Promise.all(
    healthyIntegrations.map((row) =>
      clearConnectionNeedsReconnectFromIntegrationRecovery({
        userId,
        integrationName: row.name as 'claude_code' | 'gpt_code',
        accountId: row.accountId,
      })
    )
  );
}

export async function syncConnectionAfterIntegrationAuthFailure(params: {
  integrationId: string;
  failureReason: string;
}): Promise<void> {
  const row = await prisma.integration.findUnique({
    where: { id: params.integrationId },
    select: { userId: true, name: true, accountId: true },
  });
  if (row === null) return;
  if (row.name !== 'claude_code' && row.name !== 'gpt_code') return;

  await markConnectionNeedsReconnectFromIntegrationFailure({
    userId: row.userId,
    integrationName: row.name,
    accountId: row.accountId,
    failureReason: params.failureReason,
  });
}
