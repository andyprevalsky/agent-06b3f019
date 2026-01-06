#!/usr/bin/env tsx
/**
 * Query messages for two agents to compare
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const agentWorker = 'f392491c-cea1-4d09-ba28-e4272f239ed6'; // agent worker
  const chatMode = '6a080f18-8358-44f3-8c6c-1e7f586e242b'; // chat mode

  console.log('=== AGENT WORKER (f392491c) ===');
  const workerMessages = await prisma.message.findMany({
    where: { agentId: agentWorker },
    orderBy: { timestamp: 'asc' },
  });
  console.log(`Total messages: ${workerMessages.length}`);
  workerMessages.forEach((m, i) => {
    console.log(`\n--- Message ${i + 1} ---`);
    console.log(`Role: ${m.role}`);
    console.log(`Text (${m.text.length} chars): ${m.text.substring(0, 500)}${m.text.length > 500 ? '...' : ''}`);
    console.log(`Metadata: ${JSON.stringify(m.metadata, null, 2)}`);
  });

  console.log('\n\n=== CHAT MODE (6a080f18) ===');
  const chatMessages = await prisma.message.findMany({
    where: { agentId: chatMode },
    orderBy: { timestamp: 'asc' },
  });
  console.log(`Total messages: ${chatMessages.length}`);
  chatMessages.forEach((m, i) => {
    console.log(`\n--- Message ${i + 1} ---`);
    console.log(`Role: ${m.role}`);
    console.log(`Text (${m.text.length} chars): ${m.text.substring(0, 500)}${m.text.length > 500 ? '...' : ''}`);
    console.log(`Metadata: ${JSON.stringify(m.metadata, null, 2)}`);
  });

  // Also get agent info
  console.log('\n\n=== AGENT RECORDS ===');
  const agents = await prisma.agent.findMany({
    where: { id: { in: [agentWorker, chatMode] } },
    select: {
      id: true,
      goal: true,
      status: true,
      model: true,
      messageCount: true,
      structuredResponse: true,
    },
  });
  console.log(JSON.stringify(agents, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
