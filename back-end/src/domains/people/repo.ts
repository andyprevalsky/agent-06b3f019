/**
 * People domain repo — all Prisma calls for people CRUD and message queries.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

// ---------------------------------------------------------------------------
// People list (raw SQL for server-side sort + search + pagination)
// ---------------------------------------------------------------------------

export async function countPeople(
  whereClause: string,
  params: Prisma.Sql['values'][]
): Promise<number> {
  const countResult = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
    `SELECT COUNT(*) as count FROM "Person" p WHERE ${whereClause}`,
    ...params
  );
  return Number(countResult[0].count);
}

export async function listPeople(
  whereClause: string,
  orderClause: string,
  params: Prisma.Sql['values'][]
): Promise<Record<string, unknown>[]> {
  const limitParam = `$${params.length - 1}`;
  const offsetParam = `$${params.length}`;
  return prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT
      p.*,
      MAX(mr."timestamp") as "lastMessageAt"
    FROM "Person" p
    LEFT JOIN "MessageRecord" mr ON mr."personId" = p."id"
    WHERE ${whereClause}
    GROUP BY p."id"
    ORDER BY ${orderClause}
    LIMIT ${limitParam}
    OFFSET ${offsetParam}`,
    ...params
  );
}

// ---------------------------------------------------------------------------
// Single person by ID
// ---------------------------------------------------------------------------

export async function findPersonById(id: string, userId: string) {
  return prisma.person.findFirst({
    where: { id, userId },
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deletePerson(id: string): Promise<void> {
  await prisma.person.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createPerson(data: {
  userId: string;
  firstName: string;
  lastName: string;
  age?: number;
  location?: string;
  profession?: string;
  company?: string;
  title?: string;
  industry?: string;
  email?: string;
  phoneNumber?: string;
  linkedinUrl?: string;
  instagramHandle?: string;
  facebookUrl?: string;
  twitterHandle?: string;
  relation?: string;
  communicationFrequency?: string;
  relationshipQuality?: string;
  skills: string[];
  interests: string[];
  totalOnlineReach?: number;
  estimatedNetWorthUsd?: number;
  estimatedWorldPowerRanking?: number;
  currentBandwidth?: string;
  contactStatus?: string;
  networkOrientation?: string;
  notes?: string;
  emailAddresses: string[];
}) {
  // Embedding column is left null; embedding generation is temporarily disabled.
  return prisma.person.create({ data });
}

// ---------------------------------------------------------------------------
// Messages: find person by identifiers
// ---------------------------------------------------------------------------

export async function findMatchingPeople(
  userId: string,
  whereConditions: Prisma.PersonWhereInput[]
) {
  return prisma.person.findMany({
    where: {
      userId,
      OR: whereConditions,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phoneNumber: true,
      email: true,
      _count: { select: { messageRecords: true } },
    },
  });
}

export async function findPersonWithMessages(personId: string, messageLimit: number) {
  return prisma.person.findFirst({
    where: { id: personId },
    include: {
      messageRecords: {
        orderBy: { timestamp: 'desc' as const },
        take: messageLimit,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Recent messages across all people
// ---------------------------------------------------------------------------

export async function findRecentMessages(
  userId: string,
  cutoffTime: Date | undefined,
  limit: number
) {
  return prisma.messageRecord.findMany({
    where: {
      userId,
      ...(cutoffTime === undefined ? {} : { timestamp: { gte: cutoffTime } }),
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
    select: {
      channel: true,
      from: true,
      to: true,
      timestamp: true,
      message: true,
    },
  });
}
