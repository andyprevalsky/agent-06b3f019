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

/**
 * Concurrent first texts from one new number provision exactly one account:
 * the unique User.phone index lets one create win and the rest reuse it,
 * instead of creating duplicates or failing with 500.
 */
export async function testConcurrentFirstTextsProvisionOneAccount(
  deps: PhoneFormDeps
): Promise<void> {
  const phone = deps.uniqueSmsPhone();
  const bare = phone.replace(/^\+/, '');
  try {
    // `/clear` provisions the sender without starting a supervisor run.
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => deps.postInbound(phone, '/clear'))
    );
    const statuses = responses.map((res) => res.status);
    if (statuses.some((status) => status !== 200)) {
      throw new Error(`Every concurrent first text must return 200, got ${statuses.join(',')}`);
    }
    const owners = await prisma.user.findMany({
      where: { phone: { in: [phone, bare] } },
      select: { phone: true },
    });
    if (owners.length !== 1) {
      throw new Error(`Expected exactly one provisioned account, found ${owners.length}`);
    }
    if (owners[0]?.phone !== phone) {
      throw new Error(`Expected the canonical ${phone}, stored ${String(owners[0]?.phone)}`);
    }
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

/** The phone-form/provisioning cases, registered by sms-webhook.blackbox.ts. */
export function phoneFormCases(
  deps: PhoneFormDeps
): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    {
      name: 'provisioning -- known phone in other stored form reuses its account',
      fn: () => testKnownPhoneInOtherStoredFormReusesAccount(deps),
    },
    {
      name: 'provisioning -- concurrent first texts from one number create one account',
      fn: () => testConcurrentFirstTextsProvisionOneAccount(deps),
    },
  ];
}
