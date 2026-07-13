import { Prisma } from '@prisma/client';

import { prisma } from '../database';

export interface SmsSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  inboundSeq?: number;
  providerMessageId?: string;
}

function storedMessagesArray(): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN jsonb_typeof(messages) = 'array' THEN messages
    WHEN jsonb_typeof(messages) = 'string' THEN COALESCE((messages #>> '{}')::jsonb, '[]'::jsonb)
    ELSE '[]'::jsonb
  END`;
}

async function ensureSession(userId: string): Promise<void> {
  await prisma.smsSession.upsert({
    where: { userId },
    update: {},
    create: { userId, messages: JSON.stringify([]) },
  });
}

/**
 * Persist an inbound SMS and advance its sequence in one row-locked UPDATE.
 * A superseding run may suppress an obsolete reply, but it can never suppress
 * or overwrite the user message that caused that run.
 */
export async function recordInboundSms(userId: string, content: string): Promise<number> {
  await ensureSession(userId);
  const rows = await prisma.$queryRaw<Array<{ lastInboundSeq: number }>>`
    UPDATE "SmsSession"
    SET
      "lastInboundSeq" = "lastInboundSeq" + 1,
      messages = to_jsonb((
        ${storedMessagesArray()} || jsonb_build_array(
          jsonb_build_object(
            'role', 'user',
            'content', ${content},
            'timestamp', NOW()::text,
            'inboundSeq', "lastInboundSeq" + 1
          )
        )
      )::text),
      "updatedAt" = NOW()
    WHERE "userId" = ${userId}
    RETURNING "lastInboundSeq"
  `;
  const sequence = rows[0]?.lastInboundSeq;
  if (sequence === undefined) throw new Error('Failed to persist inbound SMS');
  return sequence;
}

/** Append a successfully delivered assistant SMS without rewriting the thread. */
export async function appendOutboundSms(
  userId: string,
  content: string,
  providerMessageId?: string,
  precedingUserContent?: string
): Promise<void> {
  await ensureSession(userId);
  const precedingUserRecord =
    precedingUserContent === undefined
      ? Prisma.sql`'[]'::jsonb`
      : Prisma.sql`jsonb_build_array(
          jsonb_build_object(
            'role', 'user',
            'content', ${precedingUserContent},
            'timestamp', NOW()::text
          )
        )`;
  await prisma.$executeRaw`
    UPDATE "SmsSession"
    SET
      messages = to_jsonb((
        ${storedMessagesArray()} || ${precedingUserRecord} || jsonb_build_array(
          jsonb_strip_nulls(
            jsonb_build_object(
              'role', 'assistant',
              'content', ${content},
              'timestamp', NOW()::text,
              'providerMessageId', ${providerMessageId ?? null}
            )
          )
        )
      )::text),
      "updatedAt" = NOW()
    WHERE "userId" = ${userId}
  `;
}

export function parseSmsSessionMessages(raw: unknown): SmsSessionMessage[] {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is SmsSessionMessage =>
        typeof item === 'object' &&
        item !== null &&
        ((item as Record<string, unknown>).role === 'user' ||
          (item as Record<string, unknown>).role === 'assistant') &&
        typeof (item as Record<string, unknown>).content === 'string' &&
        typeof (item as Record<string, unknown>).timestamp === 'string'
    );
  } catch {
    return [];
  }
}
