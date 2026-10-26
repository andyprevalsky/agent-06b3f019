/**
 * Integration-row reads for the sync-progress account view.
 *
 * Each existing Integration row (userId, name, accountId) is exactly one
 * account; nothing here creates or re-keys rows.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

export async function findIntegrationAccount(userId: string, name: string, accountId: string) {
  return prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name, accountId } },
  });
}

/** Row fields an account is derived from (no secrets, no config). */
const ACCOUNT_ROW_SELECT = {
  id: true,
  name: true,
  accountId: true,
  accountEmail: true,
  status: true,
  lastSyncAt: true,
  lastSuccessfulSyncAt: true,
  failureReason: true,
  updatedAt: true,
} as const;

export type AccountRowSource = Prisma.IntegrationGetPayload<{ select: typeof ACCOUNT_ROW_SELECT }>;

/**
 * Light read of every row of one user plus the email credentials its health is
 * derived from (the poll path; one indexed per-user read, bounded by rows).
 */
export async function listAccountRowSources(userId: string) {
  return prisma.integration.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: {
      ...ACCOUNT_ROW_SELECT,
      emailCredentials: {
        where: {
          email: { not: null },
          OR: [{ accessToken: { not: null } }, { state: 'needs_reconnect' }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        // Scopes are read only to derive health (withGoogleScopeHealth strips them).
        select: { email: true, state: true, lastErrorReason: true, scopes: true, updatedAt: true },
      },
    },
  });
}
