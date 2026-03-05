#!/usr/bin/env tsx
/**
 * Query people/network data breakdown
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const userIdPrefix = process.argv[2];
  if (!userIdPrefix) {
    console.error('Usage: npx tsx back-end/scripts/query-db.ts <user-id-prefix>');
    process.exit(1);
  }

  const people = await prisma.person.findMany({
    where: { userId: { startsWith: userIdPrefix } },
    select: {
      firstName: true,
      lastName: true,
      email: true,
      phoneNumber: true,
      emailAddresses: true,
      communicationFrequency: true,
      messagesExchanged: true,
      createdAt: true,
    },
    orderBy: { messagesExchanged: 'desc' },
  });

  console.log(`Total contacts: ${people.length}`);

  // Breakdown by contact info type
  const hasPhone = people.filter(p => p.phoneNumber).length;
  const hasEmail = people.filter(p => p.email).length;
  const hasEmailAddresses = people.filter(p => {
    const addrs = p.emailAddresses as any;
    return addrs && Array.isArray(addrs) && addrs.length > 0;
  }).length;
  const hasPhoneOnly = people.filter(p => p.phoneNumber && !p.email).length;
  const hasEmailOnly = people.filter(p => !p.phoneNumber && p.email).length;
  const hasBoth = people.filter(p => p.phoneNumber && p.email).length;
  const hasNeither = people.filter(p => !p.phoneNumber && !p.email).length;

  console.log(`\n=== CONTACT INFO BREAKDOWN ===`);
  console.log(`  Has phone: ${hasPhone}`);
  console.log(`  Has email: ${hasEmail}`);
  console.log(`  Has emailAddresses (JSON): ${hasEmailAddresses}`);
  console.log(`  Phone only (likely iMessage): ${hasPhoneOnly}`);
  console.log(`  Email only (likely Gmail): ${hasEmailOnly}`);
  console.log(`  Both: ${hasBoth}`);
  console.log(`  Neither: ${hasNeither}`);

  // Frequency breakdown
  const freqMap = new Map<string, number>();
  for (const p of people) {
    const f = p.communicationFrequency || 'none';
    freqMap.set(f, (freqMap.get(f) || 0) + 1);
  }
  console.log(`\n=== COMMUNICATION FREQUENCY ===`);
  for (const [f, count] of [...freqMap.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${f}: ${count}`);
  }

  // Message count distribution
  const msgBuckets = { '0': 0, '1-10': 0, '11-50': 0, '51-100': 0, '100+': 0 };
  for (const p of people) {
    const m = p.messagesExchanged;
    if (m === 0) msgBuckets['0']++;
    else if (m <= 10) msgBuckets['1-10']++;
    else if (m <= 50) msgBuckets['11-50']++;
    else if (m <= 100) msgBuckets['51-100']++;
    else msgBuckets['100+']++;
  }
  console.log(`\n=== MESSAGE COUNT DISTRIBUTION ===`);
  for (const [bucket, count] of Object.entries(msgBuckets)) {
    console.log(`  ${bucket} messages: ${count} contacts`);
  }

  // Top 15 by messages exchanged
  console.log(`\n=== TOP 15 BY MESSAGES ===`);
  for (const p of people.slice(0, 15)) {
    const name = `${p.firstName} ${p.lastName}`.trim();
    const contact = p.phoneNumber || p.email || 'no contact';
    console.log(`  ${name}: ${p.messagesExchanged} msgs | ${contact} | ${p.communicationFrequency}`);
  }

  // Check MessageRecord count
  const msgRecordCount = await prisma.messageRecord.count({
    where: { person: { userId: { startsWith: userIdPrefix } } },
  });
  console.log(`\n=== MESSAGE RECORDS ===`);
  console.log(`Total MessageRecords: ${msgRecordCount}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
