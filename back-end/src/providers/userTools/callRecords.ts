/**
 * At-most-once records for side-effecting user tools (CLAUDE.md rule 20), on
 * the shared ToolSideEffect table (no new table):
 *
 *   operationKey  user_tool:<userId>:<key>   key = sha256(root workflow id, tool call id),
 *                                            derived by the agents workflow
 *   operationType user_tool.call
 *   request       { user_id, agent_id, tool, version_id, input_sha256 }
 *   response      the handler run record (returncode, stdout_b64, stderr_tail, …)
 *
 *   claim ─ created ─────────────────────────────► claimed   (caller runs the handler)
 *         └ exists ─┬─ different request ────────► conflict
 *                   ├─ SUCCEEDED ────────────────► done      (stored run record)
 *                   ├─ FAILED (released) ─reclaim► claimed
 *                   └─ STARTED ──────────────────► running   (age since the claim)
 *   complete  STARTED → SUCCEEDED, first write wins; returns the stored record
 *   release   STARTED → FAILED: the handler certainly never started
 *
 * 10k agents: one unique-key row per side-effecting call; every operation is a
 * unique-key read or conditional update. No scans, shared rows or locks.
 */
import type { Prisma, ToolSideEffect } from '@prisma/client';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { claimToolSideEffect, reclaimFailedToolSideEffect } from '../toolSideEffects';

const log = createLogger('UserToolCallRecords');

export const USER_TOOL_OPERATION_TYPE = 'user_tool.call';

/** One handler process run; identical shape for every executor (agents HandlerRun). */
export interface UserToolRun {
  returncode: number | null;
  stdout_b64: string;
  stderr_tail: string;
  timed_out: boolean;
  overflow: boolean;
  executor: string;
  code_session_id: string | null;
}

export interface UserToolCallRequest {
  agent_id: string;
  tool: string;
  version_id: string;
  input_sha256: string;
}

export type UserToolCallClaim =
  | { status: 'claimed' }
  | { status: 'done'; run: UserToolRun }
  | { status: 'running'; age_ms: number }
  | { status: 'conflict'; error: string };

export function userToolOperationKey(userId: string, key: string): string {
  return `user_tool:${userId}:${key}`;
}

function sameRequest(stored: unknown, expected: Record<string, string>): boolean {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return false;
  const record = stored as Record<string, unknown>;
  return Object.entries(expected).every(([field, value]) => record[field] === value);
}

function storedRun(record: ToolSideEffect): UserToolRun | null {
  const response = record.response;
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return null;
  return response as unknown as UserToolRun;
}

function evaluate(
  record: ToolSideEffect,
  expected: Record<string, string>,
  now: Date
): UserToolCallClaim | 'reclaim' {
  if (!sameRequest(record.request, expected)) {
    return {
      status: 'conflict',
      error: 'this idempotency key already belongs to a different user tool call',
    };
  }
  if (record.status === 'SUCCEEDED') {
    const run = storedRun(record);
    if (run !== null) return { status: 'done', run };
    return { status: 'conflict', error: 'the stored user tool result is malformed' };
  }
  if (record.status === 'FAILED') return 'reclaim';
  return { status: 'running', age_ms: Math.max(0, now.getTime() - record.updatedAt.getTime()) };
}

/** Claim a call before its handler starts, or learn its recorded state. */
export async function claimUserToolCall(
  userId: string,
  key: string,
  request: UserToolCallRequest,
  now = new Date()
): Promise<UserToolCallClaim> {
  const operationKey = userToolOperationKey(userId, key);
  const expected: Record<string, string> = { user_id: userId, ...request };
  const claim = await claimToolSideEffect({
    operationKey,
    operationType: USER_TOOL_OPERATION_TYPE,
    request: expected as Prisma.InputJsonValue,
  });
  if (claim.status === 'claimed') {
    log.info('Claimed user tool call', { userId, tool: request.tool, key: key.slice(0, 12) });
    return { status: 'claimed' };
  }
  const state = evaluate(claim.record, expected, now);
  if (state !== 'reclaim') return state;
  const reclaimed = await reclaimFailedToolSideEffect(operationKey);
  if (reclaimed.status === 'claimed') {
    log.info('Reclaimed released user tool call', { userId, tool: request.tool });
    return { status: 'claimed' };
  }
  const after = evaluate(reclaimed.record, expected, now);
  return after === 'reclaim' ? { status: 'running', age_ms: 0 } : after;
}

/** The call's record when it belongs to `userId`, else null. */
export async function findUserToolCall(
  userId: string,
  key: string
): Promise<ToolSideEffect | null> {
  return prisma.toolSideEffect.findUnique({
    where: { operationKey: userToolOperationKey(userId, key) },
  });
}

/**
 * Store the run record (STARTED → SUCCEEDED, first write wins) and return the
 * stored one; null when the call was never claimed or was released.
 */
export async function completeUserToolCall(
  userId: string,
  key: string,
  run: UserToolRun
): Promise<UserToolRun | null> {
  const operationKey = userToolOperationKey(userId, key);
  const written = await prisma.toolSideEffect.updateMany({
    where: { operationKey, status: 'STARTED' },
    data: {
      status: 'SUCCEEDED',
      response: run as unknown as Prisma.InputJsonValue,
      error: null,
    },
  });
  const record = await prisma.toolSideEffect.findUnique({ where: { operationKey } });
  if (record === null || record.status !== 'SUCCEEDED') return null;
  if (written.count === 1) {
    log.info('Stored user tool run record', {
      userId,
      key: key.slice(0, 12),
      returncode: run.returncode === null ? 'null' : String(run.returncode),
      timedOut: run.timed_out,
    });
  }
  return storedRun(record);
}

/** Re-open a claim whose handler never started; false when it is not STARTED. */
export async function releaseUserToolCall(
  userId: string,
  key: string,
  error: string
): Promise<boolean> {
  const released = await prisma.toolSideEffect.updateMany({
    where: { operationKey: userToolOperationKey(userId, key), status: 'STARTED' },
    data: { status: 'FAILED', error: error.slice(0, 500) },
  });
  return released.count === 1;
}
