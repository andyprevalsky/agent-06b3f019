/** Persist access requests independently of device allocation or enablement. */
import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { IPhoneError, type Transaction } from './types';

const name = 'iphone';
const accountId = '';
const where = (userId: string) => ({ userId_name_accountId: { userId, name, accountId } });
function config(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
export async function accessRequested(tx: Transaction, userId: string): Promise<boolean> {
  const row = await tx.integration.findUnique({ where: where(userId), select: { config: true } });
  return config(row?.config ?? null).accessRequested === true;
}

/** A short account lock serializes duplicate clicks across API processes. No network I/O. */
export async function claimNotification(userId: string) {
  return runTransactionWithRetry(async (tx) => {
    await tx.$queryRaw`SELECT "userId" FROM "User" WHERE "userId" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({
      where: { userId },
      select: { name: true, email: true, phone: true },
    });
    if (user === null) throw new IPhoneError(404, 'Account not found');
    const existing = await tx.integration.findUnique({ where: where(userId) });
    const previous = config(existing?.config ?? null);
    if (
      previous.accessRequested === true &&
      ['sending', 'sent'].includes(String(previous.smsState))
    )
      return null;
    const next = {
      ...previous,
      accessRequested: true,
      accessRequestedAt: previous.accessRequestedAt ?? new Date().toISOString(),
      smsState: 'sending',
    };
    const row = await tx.integration.upsert({
      where: where(userId),
      create: { userId, name, accountId, type: 'TOOL_SETUP', config: next },
      update: { config: next },
    });
    return { id: row.id, user, config: next };
  });
}
export async function finishNotification(
  claim: NonNullable<Awaited<ReturnType<typeof claimNotification>>>,
  sent: boolean
) {
  await prisma.integration.update({
    where: { id: claim.id },
    data: { config: { ...claim.config, smsState: sent ? 'sent' : 'failed' } },
  });
}
