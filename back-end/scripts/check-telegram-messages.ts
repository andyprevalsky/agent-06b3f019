import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const integration = await prisma.integration.findFirst({
    where: { name: 'telegram' },
    select: { userId: true }
  });

  if (!integration) {
    console.log('No Telegram integration found');
    return;
  }

  const messages = await prisma.messageRecord.findMany({
    where: {
      person: { userId: integration.userId },
      channel: 'TELEGRAM'
    },
    take: 10,
    orderBy: { timestamp: 'desc' },
    select: {
      message: true,
      timestamp: true,
      from: true,
      to: true,
      person: {
        select: {
          firstName: true,
          lastName: true,
          phoneNumber: true,
          email: true
        }
      }
    }
  });

  console.log('=== Sample Telegram Messages ===\n');
  messages.forEach((m, i) => {
    const direction = m.from === 'me' ? 'SENT' : 'RECV';
    const contact = [m.person?.firstName, m.person?.lastName].filter(Boolean).join(' ') || m.person?.phoneNumber || m.person?.email || 'Unknown';
    console.log(`--- Message ${i+1} ---`);
    console.log(`Direction: ${direction}`);
    console.log(`Contact: ${contact}`);
    console.log(`From: ${m.from} | To: ${m.to}`);
    console.log(`Timestamp: ${m.timestamp}`);
    console.log(`Content: ${m.message?.substring(0, 200) || '[empty]'}`);
    console.log('');
  });

  const totalContacts = await prisma.person.count({
    where: {
      userId: integration.userId,
      messages: { some: { channel: 'TELEGRAM' } }
    }
  });
  console.log('=== Stats ===');
  console.log(`Total Telegram contacts: ${totalContacts}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
