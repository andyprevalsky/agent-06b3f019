#!/usr/bin/env tsx
/**
 * Read-only dump of the SMS supervisor transcript (SmsSession.messages) for a phone.
 *
 * Usage: npx tsx scripts/dump-sms-session.ts [+19729777432] [tailCount]
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const phone = process.argv[2] ?? '+19729777432';
  const tail = Number(process.argv[3] ?? '120');

  const user = await prisma.user.findFirst({
    where: { phone },
    select: { userId: true, name: true, phone: true },
  });
  if (user === null) {
    console.log(`No user for ${phone}`);
    return;
  }
  console.log(`user=${user.userId} name=${user.name} phone=${user.phone}`);

  const session = await prisma.smsSession.findUnique({ where: { userId: user.userId } });
  if (session === null) {
    console.log('No SmsSession row');
    return;
  }
  const raw = session.messages;
  const messages = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<Record<string, unknown>>;
  console.log(`lastInboundSeq=${session.lastInboundSeq} updatedAt=${session.updatedAt.toISOString()} total=${messages.length}`);
  console.log('---');
  for (const [i, m] of messages.slice(-tail).entries()) {
    console.log(`[${messages.length - Math.min(tail, messages.length) + i}] ${JSON.stringify(m)}`);
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
