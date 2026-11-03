/**
 * Agent-to-agent message guard (Prime agent_messaging.rs): per-sender send rate
 * and per-recipient unread cap. State lives on the agents' own rows
 * (`Agent.agentMessaging`), so every operation is one primary-key statement or
 * one bounded `Message(agentId, timestamp)` range read — cost scales with the
 * one sender / recipient, never with the number of agents.
 *
 *   send ──▶ countUnreadAgentMessages(recipient)   ≥ 20 → refuse (nothing consumed)
 *        ──▶ takeAgentMessageSendToken(sender)      GCRA: burst 3, +1 token / 1000 ms
 *                                                   (one conditional UPDATE, DB clock)
 *   recipient's own read returns its agent messages ──▶ markAgentMessagesRead
 *        (workflow poll → readAt; task inbox read → taskReadAt[address])
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

/** Prime DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY / _REFILL_MS / _MAX_PENDING_PER_SESSION. */
export const AGENT_MESSAGE_RATE_BURST = 3;
export const AGENT_MESSAGE_RATE_REFILL_MS = 1_000;
export const AGENT_MESSAGE_MAX_UNREAD = 20;

interface GuardState {
  readAt?: unknown;
  taskReadAt?: unknown;
}

function isoOrNull(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** True when a keyed agent-message row already exists (an idempotent retry). */
export async function idempotentRowExists(messageId: string): Promise<boolean> {
  const row = await prisma.message.findUnique({ where: { id: messageId }, select: { id: true } });
  return row !== null;
}

/** The recipient's guard state (`Agent.agentMessaging`), one primary-key read. */
export async function findAgentMessagingState(agentId: string): Promise<unknown> {
  const row = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { agentMessaging: true },
  });
  return row?.agentMessaging ?? null;
}

/** When `recipient` (agent or one of its tasks) last consumed agent messages. */
export function readMarkOf(state: unknown, taskId: string | null): Date | null {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return null;
  const guard = state as GuardState;
  if (taskId === null) return isoOrNull(guard.readAt);
  const marks = guard.taskReadAt;
  if (typeof marks !== 'object' || marks === null || Array.isArray(marks)) return null;
  return isoOrNull((marks as Record<string, unknown>)[taskId]);
}

/**
 * Agent messages to `agentId` (or its task `taskId`) created after `since`,
 * counted up to `AGENT_MESSAGE_MAX_UNREAD` (bounded range read).
 */
export async function countUnreadAgentMessages(
  agentId: string,
  taskId: string | null,
  since: Date | null
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ unread: number }>>`
    SELECT count(*)::int AS unread FROM (
      SELECT 1 FROM "Message"
      WHERE "agentId" = ${agentId}
        AND "timestamp" > ((${(since ?? new Date(0)).toISOString()})::timestamptz AT TIME ZONE 'UTC')
        AND "role" = 'USER'
        AND "metadata"->>'agentMessage' = 'true'
        AND ("metadata"->>'recipientTaskId') IS NOT DISTINCT FROM ${taskId}
      LIMIT ${AGENT_MESSAGE_MAX_UNREAD}
    ) unread_rows`;
  return rows[0]?.unread ?? 0;
}

/**
 * GCRA token bucket on the sender's row: allowed when its theoretical arrival
 * time is at most (burst - 1) intervals ahead of now; each send pushes it one
 * interval. One conditional UPDATE, so concurrent sends and backend instances
 * share the one bucket. False = rate limited (the row is unchanged).
 */
export async function takeAgentMessageSendToken(senderId: string): Promise<boolean> {
  const tolerance = (AGENT_MESSAGE_RATE_BURST - 1) * AGENT_MESSAGE_RATE_REFILL_MS;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH clock AS (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms)
    UPDATE "Agent" AS a
    SET "agentMessaging" = jsonb_set(
      COALESCE(a."agentMessaging", '{}'::jsonb),
      '{rateTatMs}',
      to_jsonb(GREATEST(COALESCE((a."agentMessaging"->>'rateTatMs')::bigint, clock.now_ms), clock.now_ms)
        + ${AGENT_MESSAGE_RATE_REFILL_MS}::bigint)
    )
    FROM clock
    WHERE a."id" = ${senderId}
      AND COALESCE((a."agentMessaging"->>'rateTatMs')::bigint, clock.now_ms) <= clock.now_ms + ${tolerance}::bigint
    RETURNING a."id"`;
  return rows.length > 0;
}

/** Record that `agentId` (taskId null) or its task consumed agent messages up to `upTo`. */
export async function markAgentMessagesRead(
  agentId: string,
  taskId: string | null,
  upTo: Date
): Promise<void> {
  const mark = upTo.toISOString();
  const patch: Prisma.Sql =
    taskId === null
      ? Prisma.sql`jsonb_build_object('readAt', ${mark}::text)`
      : Prisma.sql`jsonb_build_object('taskReadAt',
          COALESCE("agentMessaging"->'taskReadAt', '{}'::jsonb) || jsonb_build_object(${taskId}::text, ${mark}::text))`;
  await prisma.$executeRaw`
    UPDATE "Agent" SET "agentMessaging" = COALESCE("agentMessaging", '{}'::jsonb) || ${patch}
    WHERE "id" = ${agentId}`;
}

/** Newest timestamp among delivered agent-message rows, or null when none. */
export function newestTimestamp(rows: Array<{ timestamp: Date | string }>): Date | null {
  let newest: Date | null = null;
  for (const row of rows) {
    const at = row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp);
    if (!Number.isNaN(at.getTime()) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}
