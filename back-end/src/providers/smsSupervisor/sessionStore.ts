import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { prisma } from '../database';

export interface SmsSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  inboundSeq?: number;
  providerMessageId?: string;
  /**
   * Set on turns the supervisor did NOT author — lifecycle SMS emitted directly
   * by a spawned agent (`agent_started`, `completion`, `cost_limit`, …). They are
   * `assistant` turns because the user experiences them as Rose talking, but the
   * marker lets callers tell "I said this" from "an agent said this for me".
   */
  origin?: 'agent-lifecycle';
}

/**
 * The ONE timestamp format stored on a session message.
 *
 * `fetchSessionMessagesSince` compares these as plain strings, which is only
 * correct while every writer emits the same fixed-width UTC format that
 * `Date.toISOString()` produces. `NOW()::text` does NOT: it renders
 * `2026-08-05 03:09:02.185+00`, whose space at index 10 sorts BEFORE the `T` of
 * any ISO watermark. Every stored message therefore compared as older than a
 * watermark taken the same day, and the catch-up poll returned nothing on every
 * round — the blind spot it exists to close stayed wide open.
 *
 * Keep this the only way a session timestamp is written.
 */
const SESSION_TIMESTAMP_SQL = Prisma.sql`to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

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
          'timestamp', ${SESSION_TIMESTAMP_SQL},
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
            'timestamp', ${SESSION_TIMESTAMP_SQL},
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
            'timestamp', ${SESSION_TIMESTAMP_SQL}
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
              'timestamp', ${SESSION_TIMESTAMP_SQL},
              'providerMessageId', ${providerMessageId ?? null}
            )
          )
        )
      )::text),
      "updatedAt" = NOW()
    WHERE "userId" = ${userId}
  `;
}

/**
 * Append a lifecycle SMS a spawned agent sent straight to the user's phone.
 *
 * Without this the supervisor's transcript held only its own sends, so on the
 * next inbound it had no idea the user had already been told "Started: …" or
 * "Done: …" — and narrated the same progress again itself. Best-effort by
 * design: the SMS is already delivered by the time we get here, so a failed
 * append must never fail the caller.
 */
export async function appendLifecycleSms(
  userId: string,
  content: string,
  providerMessageId?: string
): Promise<void> {
  await ensureSession(userId);
  await prisma.$executeRaw`
    UPDATE "SmsSession"
    SET
      messages = to_jsonb((
        ${storedMessagesArray()} || jsonb_build_array(
          jsonb_strip_nulls(
            jsonb_build_object(
              'role', 'assistant',
              'content', ${content},
              'timestamp', ${SESSION_TIMESTAMP_SQL},
              'providerMessageId', ${providerMessageId ?? null},
              'origin', 'agent-lifecycle'
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

/**
 * Lifecycle SMS added to the user's thread since `sinceIso`.
 *
 * A supervisor run composes its context once, at wake-up. Anything that reaches
 * the phone *during* the run — an agent it just spawned announcing itself, a
 * sibling agent finishing, an approval request — is invisible until the next
 * inbound SMS. That blind spot is what produces duplicate traffic: the
 * supervisor has no evidence the user was told anything, so it says it again.
 *
 * Scoped to `origin: 'agent-lifecycle'` — turns the supervisor did NOT author.
 * Its own sends are already in its context, and `appendOutboundSms` re-stores
 * the triggering inbound under a fresh timestamp, so replaying everything would
 * hand the run a duplicate `user` turn and invite a second reply to a message it
 * had already answered. Returning only what an agent said, verbatim and in
 * order, is exactly the evidence the supervisor lacks.
 */
export async function fetchSessionMessagesSince(
  userId: string,
  sinceIso: string
): Promise<SmsSessionMessage[]> {
  const session = await prisma.smsSession.findUnique({
    where: { userId },
    select: { messages: true },
  });
  if (session === null) return [];
  return parseSmsSessionMessages(session.messages).filter(
    (message) => message.origin === 'agent-lifecycle' && message.timestamp > sinceIso
  );
}
