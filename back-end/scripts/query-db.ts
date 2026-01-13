#!/usr/bin/env tsx
/**
 * Query messages to compare file_pointer between USER and ASSISTANT messages
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find recent USER messages with file_pointer
  const userMessages = await prisma.message.findMany({
    where: {
      role: 'USER',
      filePointer: { not: null },
    },
    orderBy: { timestamp: 'desc' },
    take: 3,
    select: {
      id: true,
      role: true,
      text: true,
      timestamp: true,
      filePointer: true,
    },
  });

  console.log('=== USER messages with file_pointer ===');
  for (const msg of userMessages) {
    console.log(`\n--- Message ${msg.id} ---`);
    console.log(`Role: ${msg.role}`);
    console.log(`Text: ${msg.text?.substring(0, 50) || '(empty)'}`);
    console.log(`FilePointer: ${JSON.stringify(msg.filePointer, null, 2)}`);
  }

  // Find recent ASSISTANT messages with file_pointer
  const assistantMessages = await prisma.message.findMany({
    where: {
      role: 'ASSISTANT',
      filePointer: { not: null },
    },
    orderBy: { timestamp: 'desc' },
    take: 3,
    select: {
      id: true,
      role: true,
      text: true,
      timestamp: true,
      filePointer: true,
    },
  });

  console.log('\n\n=== ASSISTANT messages with file_pointer ===');
  for (const msg of assistantMessages) {
    console.log(`\n--- Message ${msg.id} ---`);
    console.log(`Role: ${msg.role}`);
    console.log(`Text: ${msg.text?.substring(0, 50) || '(empty)'}`);
    console.log(`FilePointer: ${JSON.stringify(msg.filePointer, null, 2)}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
