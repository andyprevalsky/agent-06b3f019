/** Persistence for integration requests (Integration rows named 'integration-request'). */
import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { IntegrationRequestError } from './types.integrationRequest';

const NAME = 'integration-request';
const DAILY_LIMIT = 10;

interface RequestConfig {
  kind: 'integration-request-v1';
  request: string;
  smsState: 'sending' | 'sent' | 'failed';
}

function requestConfig(raw: Prisma.JsonValue | null): RequestConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw.kind === 'integration-request-v1' ? (raw as unknown as RequestConfig) : null;
}

export async function claimIntegrationRequest(userId: string, request: string, requestId: string) {
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

export async function finishIntegrationRequest(
  id: string,
  request: string,
  sent: boolean
): Promise<void> {
  await prisma.integration.update({
    where: { id },
    data: {
      config: {
        kind: 'integration-request-v1',
        request,
        smsState: sent ? 'sent' : 'failed',
      } as Prisma.InputJsonValue,
    },
  });
}
