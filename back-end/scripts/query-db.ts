#!/usr/bin/env tsx
/**
 * Query agent details
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const agent = await prisma.agent.findUnique({
    where: { id: '8fcd3e48-101e-4184-afcd-b7149583a024' },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!agent) {
    console.log('Agent not found');
    return;
  }

  console.log('=== AGENT ===');
  console.log(`ID: ${agent.id}`);
  console.log(`Status: ${agent.status}`);
  console.log(`Goal: ${agent.goal}`);
  console.log(`Created: ${agent.createdAt}`);
  console.log(`Updated: ${agent.updatedAt}`);
  console.log(`Progress: ${agent.progress}`);
  console.log(`Tokens: ${agent.tokensUsed}`);
  console.log(`Error: ${agent.error}`);
  console.log(`\n=== MESSAGES (${agent.messages.length}) ===`);
  for (const msg of agent.messages) {
    const content = typeof msg.content === 'string'
      ? msg.content.substring(0, 200)
      : JSON.stringify(msg.content).substring(0, 200);
    console.log(`\n[${msg.role}] ${msg.createdAt}`);
    console.log(`  ${content}`);
    if (msg.metadata) {
      console.log(`  metadata: ${JSON.stringify(msg.metadata).substring(0, 200)}`);
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
