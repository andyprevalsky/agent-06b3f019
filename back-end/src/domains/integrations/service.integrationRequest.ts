/**
 * "An integration not listed here?" requests from the Integrations page.
 *
 *   POST {request, request_id} ──► claim row (Integration name 'integration-request',
 *        accountId = request_id, smsState sending) under the user's row lock
 *          ├─ already sending/sent for this request_id ──► return it (no second SMS)
 *          └─ claimed ──► SMS the admin "<user> wants a new integration <X>"
 *                         ──► smsState sent | failed (a retry may reclaim failed)
 *
 * At most DAILY_LIMIT requests per user per 24 h (409 beyond that).
 */
import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import { IPHONE_ADMIN_PHONE } from '../../providers/phoneAccountPolicy';
import { sendSms } from '../../providers/smsQueue';

const log = createLogger('IntegrationRequests');
const NAME = 'integration-request';
const DAILY_LIMIT = 10;

export type IntegrationRequestSmsSender = typeof sendSms;

export class IntegrationRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

interface RequestConfig {
  kind: 'integration-request-v1';
  request: string;
  smsState: 'sending' | 'sent' | 'failed';
}

function requestConfig(raw: Prisma.JsonValue | null): RequestConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw.kind === 'integration-request-v1' ? (raw as unknown as RequestConfig) : null;
}

async function claim(userId: string, request: string, requestId: string) {
  return runTransactionWithRetry(async (tx) => {
    await tx.$queryRaw`SELECT "userId" FROM "User" WHERE "userId" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { userId },
      select: { name: true, email: true, phone: true },
    });
    if (user === null) throw new IntegrationRequestError(404, 'Account not found');
    const key = { userId_name_accountId: { userId, name: NAME, accountId: requestId } };
    const existing = await tx.integration.findUnique({ where: key });
    const previous = requestConfig(existing?.config ?? null);
    if (previous && previous.smsState !== 'failed') return { user, row: null };
    if (!existing) {
      const recent = await tx.integration.count({
        where: { userId, name: NAME, createdAt: { gt: new Date(Date.now() - 86_400_000) } },
      });
      if (recent >= DAILY_LIMIT)
        throw new IntegrationRequestError(409, 'You have sent the maximum requests for today.');
    }
    const config: RequestConfig = { kind: 'integration-request-v1', request, smsState: 'sending' };
    const row = await tx.integration.upsert({
      where: key,
      create: {
        userId,
        name: NAME,
        accountId: requestId,
        type: 'TOOL_SETUP',
        config: config as unknown as Prisma.InputJsonValue,
      },
      update: { config: config as unknown as Prisma.InputJsonValue },
    });
    return { user, row };
  });
}

export async function requestIntegration(
  userId: string,
  request: string,
  requestId: string,
  send: IntegrationRequestSmsSender = sendSms
): Promise<{ status: 'sent' }> {
  const { user, row } = await claim(userId, request, requestId);
  if (row === null) return { status: 'sent' };
  let sent = false;
  try {
    const who =
      [user.name, user.email, user.phone]
        .filter((v) => v !== null && v.trim() !== '')
        .join(' · ') || userId;
    const result = await send(
      IPHONE_ADMIN_PHONE,
      `${who} wants a new integration: ${request} (account ${userId}).`
    );
    if (!result.success)
      throw new IntegrationRequestError(503, 'Could not send your request. Try again.');
    sent = true;
    log.info('[IntegrationRequests] admin notified', { userId, integrationId: row.id });
  } finally {
    // The row survives a failed delivery; a retry with the same request_id reclaims it.
    await prisma.integration.update({
      where: { id: row.id },
      data: {
        config: {
          kind: 'integration-request-v1',
          request,
          smsState: sent ? 'sent' : 'failed',
        } as Prisma.InputJsonValue,
      },
    });
  }
  return { status: 'sent' };
}
