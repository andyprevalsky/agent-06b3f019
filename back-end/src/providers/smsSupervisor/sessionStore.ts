import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { prisma } from '../database';

export interface SmsSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  inboundSeq?: number;
  providerMessageId?: string;
}

function storedMessagesArray(column: Prisma.Sql = Prisma.sql`messages`): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN jsonb_typeof(${column}) = 'array' THEN ${column}
    WHEN jsonb_typeof(${column}) = 'string' THEN COALESCE((${column} #>> '{}')::jsonb, '[]'::jsonb)
    ELSE '[]'::jsonb
  END`;
}

async function ensureSession(userId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "SmsSession" (id, "userId", messages, "lastInboundSeq", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${userId}, to_jsonb('[]'::text), 0, NOW(), NOW())
    ON CONFLICT ("userId") DO NOTHING
  `;
}

/**
 * Persist an inbound SMS and advance its sequence in one row-locked UPDATE.
 * A superseding run may suppress an obsolete reply, but it can never suppress
 * or overwrite the user message that caused that run.
 */
export async function recordInboundSms(userId: string, content: string): Promise<number> {
  const sessionMessages = storedMessagesArray(Prisma.sql`"SmsSession".messages`);
  const rows = await prisma.$queryRaw<Array<{ lastInboundSeq: number }>>`
    INSERT INTO "SmsSession" (id, "userId", messages, "lastInboundSeq", "createdAt", "updatedAt")
    VALUES (
      ${randomUUID()},
      ${userId},
      to_jsonb(jsonb_build_array(
        jsonb_build_object(
          'role', 'user',
          'content', ${content},
          'timestamp', NOW()::text,
          'inboundSeq', 1
        )
      )::text),
      1,
      NOW(),
      NOW()
    )
    ON CONFLICT ("userId") DO UPDATE
    SET
      "lastInboundSeq" = "SmsSession"."lastInboundSeq" + 1,
      messages = to_jsonb((
        ${sessionMessages} || jsonb_build_array(
          jsonb_build_object(
            'role', 'user',
            'content', ${content},
            'timestamp', NOW()::text,
            'inboundSeq', "SmsSession"."lastInboundSeq" + 1
          )
        )
      )::text),
      "updatedAt" = NOW()
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
