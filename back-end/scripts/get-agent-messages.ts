#!/usr/bin/env ts-node
/**
 * Get messages for a specific agent
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const agentId = process.argv[2];
  
  if (!agentId) {
    console.error('Usage: ts-node get-agent-messages.ts <agent-id>');
    process.exit(1);
  }
  
  const messages = await prisma.message.findMany({
    where: {
      agentId: agentId,
    },
    orderBy: {
      createdAt: 'asc',
    },
    select: {
      id: true,
      role: true,
      text: true,
      createdAt: true,
    },
  });
  
  console.log(`\nFound ${messages.length} messages for agent ${agentId}:\n`);
  
  for (const msg of messages) {
    const preview = msg.text.length > 100 ? msg.text.substring(0, 100) + '...' : msg.text;
    console.log(`[${msg.createdAt.toISOString()}] ${msg.role}: ${preview}`);
    console.log('---');
  }
  
  await prisma.$disconnect();
}

main();

