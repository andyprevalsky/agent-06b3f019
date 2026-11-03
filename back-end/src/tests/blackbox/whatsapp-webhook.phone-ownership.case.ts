/**
 * One phone maps to one account on inbound WhatsApp: a number whose account
 * stored it in the legacy bare-digit form reuses that account instead of
 * provisioning a second one. Registered by whatsapp-webhook.blackbox.ts.
 */

import './assertLocalDatabase';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';

interface WhatsAppOwnershipDeps {
  baseUrl: string;
  request: (url: string, options?: RequestInit) => Promise<{ status: number; data: unknown }>;
  inboundPayload: (from: string, text: string, messageId?: string) => Record<string, unknown>;
  uniqueWaNumber: () => string;
}

export async function testInboundKnownNumberReusesAccount(
  deps: WhatsAppOwnershipDeps
): Promise<void> {
  const wa = deps.uniqueWaNumber();
  const phone = `+${wa}`;
  const userId = `bb-wa-known-${randomUUID()}`;
  await prisma.user.create({ data: { userId, phone: wa, isAnonymous: false } });
  try {
    const res = await deps.request(`${deps.baseUrl}/api/whatsapp/webhook`, {
      method: 'POST',
      body: JSON.stringify(deps.inboundPayload(wa, 'hi again', `wamid.known.${wa}`)),
    });
    if (res.status !== 200) {
      throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    }
    const owners = await prisma.user.findMany({
      where: { phone: { in: [phone, wa] } },
      select: { userId: true },
    });
    if (owners.length !== 1 || owners[0]?.userId !== userId) {
      throw new Error(`Known number must keep its one account, found ${JSON.stringify(owners)}`);
    }
    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (!session || session.lastInboundSeq < 1) {
      throw new Error('Expected the existing account to receive the inbound message');
    }
  } finally {
    // Supersede the in-flight supervisor run so its background reply self-cancels.
    await prisma.smsSession
      .updateMany({ where: { userId }, data: { lastInboundSeq: 9999 } })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prisma.smsSession.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.credit.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { userId } }).catch(() => {});
  }
}
