/**
 * One phone maps to one account on inbound SMS: a '+digits' sender resolves to
 * the existing account stored as bare 'digits' instead of provisioning a
 * duplicate. Registered by sms-webhook.blackbox.ts.
 */

import './assertLocalDatabase';
import { prisma } from '../../providers/database';

interface PhoneFormDeps {
  postInbound: (phone: string, body: string) => Promise<{ status: number; data: unknown }>;
  uniqueSmsPhone: () => string;
}

export async function testKnownPhoneInOtherStoredFormReusesAccount(
  deps: PhoneFormDeps
): Promise<void> {
  const phone = deps.uniqueSmsPhone();
  const bare = phone.replace(/^\+/, '');
  const userId = `bb-sms-forms-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
  await prisma.user.create({ data: { userId, phone: bare, isAnonymous: true } });
  try {
    // `/clear` resolves the sender's account without starting a supervisor run.
    const res = await deps.postInbound(phone, '/clear');
    if (res.status !== 200) {
      throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    }
    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (!session) throw new Error('Expected the existing account to receive the inbound SMS');
    const owners = await prisma.user.count({ where: { phone: { in: [phone, bare] } } });
    if (owners !== 1) throw new Error(`Expected one account for the phone, found ${owners}`);
  } finally {
    const rows = await prisma.user.findMany({
      where: { phone: { in: [phone, bare] } },
      select: { userId: true },
    });
    const ids = rows.map((row) => row.userId);
    await prisma.smsSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.credit.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { userId: { in: ids } } });
  }
}
