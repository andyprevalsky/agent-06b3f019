#!/usr/bin/env tsx
/** Blackbox contract for the voice-history endpoint used by message_person. */

import { randomUUID } from 'node:crypto';
import { MessageChannel } from '@prisma/client';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';

config();

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3001';
const apiKey = process.env.BACKEND_API_KEY || '';

async function main(): Promise<void> {
  const userId = `people-voice-${randomUUID()}`;
  const oldTimestamp = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const recentTimestamp = new Date(Date.now() - 60 * 60 * 1000);
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    const person = await prisma.person.create({
      data: { userId, firstName: 'Voice', lastName: 'History', phoneNumber: '+15550001111' },
    });
    await prisma.messageRecord.createMany({
      data: [
        {
          personId: person.id,
          userId,
          channel: MessageChannel.IMESSAGE,
          from: 'me',
          to: '+15550001111',
          timestamp: oldTimestamp,
          externalId: randomUUID(),
          message: 'older voice sample',
        },
        {
          personId: person.id,
          userId,
          channel: MessageChannel.IMESSAGE,
          from: 'me',
          to: '+15550001111',
          timestamp: recentTimestamp,
          externalId: randomUUID(),
          message: 'recent voice sample',
        },
      ],
    });

    const headers = { 'X-API-Key': apiKey, 'X-User-Id': userId };
    const response = await fetch(`${baseUrl}/api/people/messages/recent?limit=100`, { headers });
    if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
    const result = (await response.json()) as {
      messages: Array<{ message: string; timestamp: string }>;
    };
    if (result.messages.length !== 2) {
      throw new Error(
        `expected old and recent messages without a days filter, got ${result.messages.length}`
      );
    }
    if (
      result.messages[0]?.message !== 'recent voice sample' ||
      result.messages[1]?.message !== 'older voice sample' ||
      result.messages[1]?.timestamp !== oldTimestamp.toISOString()
    ) {
      throw new Error(`wrong order or timestamp: ${JSON.stringify(result.messages)}`);
    }
    console.log('PASS people voice history has no default calendar cutoff and retains timestamps');
  } finally {
    await prisma.messageRecord.deleteMany({ where: { person: { userId } } });
    await prisma.person.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
