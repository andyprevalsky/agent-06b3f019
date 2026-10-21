/**
 * Release Steel sessions this environment created and no longer holds.
 *
 * A Steel session bills until it is released or its timeout elapses. Every
 * normal path releases its session, but a process that dies, a cancelled task,
 * or a recovery candidate that never became the task's browser can leave one
 * running for its full lifetime: 4% of sessions did this in early October 2026
 * and they were 52% of Steel minutes.
 *
 *   steel.sessions.list(live)
 *     ├─ not ours (marker)                   → leave alone (another environment)
 *     ├─ younger than REAPER_MIN_AGE_MS      → leave alone (still being set up)
 *     ├─ an ACTIVE/PAUSED BrowserSession row → leave alone (a task owns it)
 *     ├─ registered in-flight by this process → leave alone
 *     └─ otherwise                           → release
 *
 * Runs under a DB lease so one instance reconciles at a time.
 */

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { releaseSteelRemoteSession, steel } from './session';
import { reconcileSteelCandidateCleanup } from './candidateCleanup';
import {
  SHARED_STEEL_IDENTITY,
  inFlightSteelSessionIds,
  isOwnedSteelSessionId,
  steelEnvironmentIdentity,
} from './sessionIdentity';

const log = createLogger('SteelSessionReaper');

/** A session still inside its setup window is never reaped. */
export const STEEL_REAPER_MIN_AGE_MS = 10 * 60 * 1000;
export const STEEL_REAPER_LEASE_KEY = 'scheduled-job:steel-session-reaper';
const STEEL_REAPER_LEASE_TYPE = 'STEEL_SESSION_REAPER_JOB_LEASE';
const STEEL_REAPER_LEASE_MS = 5 * 60 * 1000;

export interface LiveSteelSession {
  id: string;
  createdAt: string;
}

export interface SteelReaperDependencies {
  listLiveSessions: () => Promise<LiveSteelSession[]>;
  heldSessionIds: (candidates: string[]) => Promise<Set<string>>;
  inFlightSessionIds: () => ReadonlySet<string>;
  isOwned: (sessionId: string) => boolean;
  identity: () => string;
  release: (sessionId: string) => Promise<void>;
  now: () => number;
}

export interface SteelReaperSummary {
  live: number;
  owned: number;
  released: number;
  failed: number;
  skippedHeld: number;
  skippedYoung: number;
  releasedIds: string[];
}

async function listLiveSteelSessions(): Promise<LiveSteelSession[]> {
  const sessions: LiveSteelSession[] = [];
  for await (const session of steel.sessions.list({ status: 'live', limit: 100 })) {
    sessions.push({ id: session.id, createdAt: session.createdAt });
  }
  return sessions;
}

/** Session ids a task still owns: its BrowserSession row is live or resumable. */
async function heldSteelSessionIds(candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await prisma.browserSession.findMany({
    where: { sessionId: { in: candidates }, status: { in: ['ACTIVE', 'PAUSED'] } },
    select: { sessionId: true },
  });
  return new Set(rows.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId])));
}

function defaultDependencies(): SteelReaperDependencies {
  return {
    listLiveSessions: listLiveSteelSessions,
    heldSessionIds: heldSteelSessionIds,
    inFlightSessionIds: inFlightSteelSessionIds,
    isOwned: (sessionId) => isOwnedSteelSessionId(sessionId),
    identity: () => steelEnvironmentIdentity(),
    release: releaseSteelRemoteSession,
    now: () => Date.now(),
  };
}

export async function reconcileOrphanedSteelSessions(
  overrides: Partial<SteelReaperDependencies> = {}
): Promise<SteelReaperSummary> {
  const deps = { ...defaultDependencies(), ...overrides };
  if (deps.identity() === SHARED_STEEL_IDENTITY) {
    // No distinct identity means another stack may carry this marker too.
    return {
      live: 0,
      owned: 0,
      released: 0,
      failed: 0,
      skippedHeld: 0,
      skippedYoung: 0,
      releasedIds: [],
    };
  }
  const live = await deps.listLiveSessions();
  const owned = live.filter((session) => deps.isOwned(session.id));
  const summary: SteelReaperSummary = {
    live: live.length,
    owned: owned.length,
    released: 0,
    failed: 0,
    skippedHeld: 0,
    skippedYoung: 0,
    releasedIds: [],
  };
  const minCreatedAt = deps.now() - STEEL_REAPER_MIN_AGE_MS;
  const oldEnough = owned.filter((session) => Date.parse(session.createdAt) <= minCreatedAt);
  summary.skippedYoung = owned.length - oldEnough.length;
  if (oldEnough.length === 0) return summary;

  // Read the in-flight set before the held-row query: a session whose row
  // commits (and is unregistered) between the two reads is then still seen by
  // the later DB query, so it is never in neither set.
  const inFlight = deps.inFlightSessionIds();
  const held = await deps.heldSessionIds(oldEnough.map((session) => session.id));
  for (const session of oldEnough) {
    if (held.has(session.id) || inFlight.has(session.id)) {
      summary.skippedHeld += 1;
      continue;
    }
    try {
      await deps.release(session.id);
      summary.released += 1;
      summary.releasedIds.push(session.id);
      log.warn('Released an orphaned Steel session', {
        session_id: session.id,
        created_at: session.createdAt,
        age_minutes: Math.round((deps.now() - Date.parse(session.createdAt)) / 60_000),
      });
    } catch (error) {
      summary.failed += 1;
      log.error('Failed to release an orphaned Steel session', {
        session_id: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}

async function acquireLease(ownerId: string): Promise<boolean> {
  const now = new Date();
  const liveCutoff = new Date(now.getTime() - STEEL_REAPER_LEASE_MS);
  const expiresAt = new Date(now.getTime() + STEEL_REAPER_LEASE_MS);
  const rows = await prisma.$queryRaw<Array<{ externalId: string }>>(Prisma.sql`
    INSERT INTO "ToolSideEffect"
      (id, "operationKey", "operationType", status, "externalId", request, "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${STEEL_REAPER_LEASE_KEY}, ${STEEL_REAPER_LEASE_TYPE}, 'STARTED', ${ownerId},
       ${JSON.stringify({ expiresAt: expiresAt.toISOString() })}::jsonb, ${now}, ${now})
    ON CONFLICT ("operationKey") DO UPDATE SET
      "operationType" = EXCLUDED."operationType",
      status = 'STARTED',
      "externalId" = EXCLUDED."externalId",
      request = EXCLUDED.request,
      response = NULL,
      error = NULL,
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "ToolSideEffect".status <> 'STARTED'
       OR "ToolSideEffect"."updatedAt" <= ${liveCutoff}
    RETURNING "externalId"
  `);
  return rows[0]?.externalId === ownerId;
}

async function releaseLease(ownerId: string): Promise<void> {
  await prisma.toolSideEffect.updateMany({
    where: {
      operationKey: STEEL_REAPER_LEASE_KEY,
      operationType: STEEL_REAPER_LEASE_TYPE,
      status: 'STARTED',
      externalId: ownerId,
    },
    data: { status: 'RELEASED', response: { releasedAt: new Date().toISOString() } },
  });
}

export async function runSteelSessionReaperWithLease(): Promise<SteelReaperSummary | null> {
  const ownerId = randomUUID();
  if (!(await acquireLease(ownerId))) return null;
  try {
    await reconcileSteelCandidateCleanup();
    return await reconcileOrphanedSteelSessions();
  } finally {
    await releaseLease(ownerId).catch((error: unknown) => {
      log.error('Failed to release the Steel reaper lease', {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
