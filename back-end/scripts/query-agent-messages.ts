#!/usr/bin/env tsx
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const agentId = '36a3c0a4-7e05-4231-8ab9-d722a42d26a2';

  const messages = await prisma.message.findMany({
    where: { agentId },
    orderBy: { createdAt: 'asc' },
  });

  console.log('Total messages: ' + messages.length);
  console.log('\n=== LAST 60 MESSAGES ===');
  for (const m of messages.slice(-60)) {
    console.log('[' + m.role + '] time=' + m.createdAt.toISOString());
    if (m.text) console.log('  ' + m.text.slice(0, 500));
    if (m.metadata) console.log('  metadata: ' + JSON.stringify(m.metadata).slice(0, 300));
    console.log('---');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
