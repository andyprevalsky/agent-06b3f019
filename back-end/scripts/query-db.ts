#!/usr/bin/env tsx
/**
 * Query all messages for a specific agent
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const agentId = 'f70573b8-25c4-4f9e-9fef-b63cadd5424e';

  // Get all messages for this agent
  const messages = await prisma.message.findMany({
    where: { agentId },
    orderBy: { timestamp: 'asc' },
    select: {
      id: true,
      role: true,
      text: true,
      timestamp: true,
      filePointer: true,
      metadata: true,
    },
  });

  console.log(`=== All ${messages.length} messages for agent ${agentId} ===\n`);

  for (const msg of messages) {
    const hasFile = msg.filePointer !== null;
    const meta = msg.metadata as any;
    const toolName = meta?.toolName || '';
    const toolStatus = meta?.toolStatus || '';
    const toolSuffix = toolName ? ` [${toolName}:${toolStatus}]` : '';

    console.log(`--- Message ${msg.id} ---`);
    console.log(`Role: ${msg.role}${toolSuffix}`);
    console.log(`Text: ${msg.text?.substring(0, 100) || '(empty)'}...`);
    console.log(`HasFilePointer: ${hasFile}`);
    if (hasFile) {
      console.log(`FilePointer: ${JSON.stringify(msg.filePointer, null, 2)}`);
    }
    console.log('');
  }

  // Summary
  const withFiles = messages.filter(m => m.filePointer !== null);
  console.log(`\n=== Summary ===`);
  console.log(`Total messages: ${messages.length}`);
  console.log(`Messages with filePointer: ${withFiles.length}`);
  if (withFiles.length > 0) {
    console.log(`\nMessages with files:`);
    for (const m of withFiles) {
      console.log(`  - ${m.id} (${m.role}): ${JSON.stringify(m.filePointer)}`);
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
