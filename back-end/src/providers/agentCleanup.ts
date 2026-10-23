import { randomUUID } from 'node:crypto';
import { Sandbox } from 'e2b';
import { Prisma } from '@prisma/client';
import { prisma } from './database';
import { createLogger } from './logger';
import { cleanupAgentPurchaseCards } from './purchaseCleanup';
import { closeSession } from './browser';
import { withSteelLifecycleClaim } from './steel/lifecycleClaim';
import { closeLocalClaudeCodeSession, isLocalClaudeCodeSandboxId } from './claudeCodeLocalSession';
import { isLocalDeviceSandboxId } from './localDevices/hub';
import { closeLocalDeviceCodeSession } from './localDevices/session';

const log = createLogger('Cleanup');

export interface BrowserSessionReleaseDependencies {
  findActiveSessions: (
    agentId: string
  ) => Promise<Array<{ id?: string; sessionId: string | null }>>;
  closeSession: (sessionId: string, pause: boolean) => Promise<void>;
  retireUnmaterializedSession: (agentId: string, taskId: string) => Promise<boolean>;
}

interface ActiveCodeSession {
  id: string;
  sandboxId: string;
}

export interface CodeSessionReleaseDependencies {
  findActiveCodeSessions: (agentId: string) => Promise<ActiveCodeSession[]>;
  /** Resolves once the sandbox is gone, including when it was already absent; throws when that is unknown. */
  killSandbox: (session: ActiveCodeSession) => Promise<void>;
  markClosed: (sessionId: string) => Promise<void>;
}

export interface TerminalBrowserReleaseDependencies {
  findTerminalAgentIds: (batchSize: number) => Promise<string[]>;
  releaseBrowserSessions: typeof releaseAgentBrowserSessions;
}

export interface TerminalBrowserReleaseOptions {
  batchSize?: number;
  deadlineAtMs?: number;
}

export interface TerminalBrowserReleaseSummary {
  discovered: number;
  released: number;
  failed: number;
}

export type TerminalBrowserReleaseLeasedResult =
  { acquired: false; summary: null } | { acquired: true; summary: TerminalBrowserReleaseSummary };

interface TerminalBrowserReleaseLeaseDependencies {
  acquireLease: (ownerId: string) => Promise<boolean>;
  releaseLease: (ownerId: string) => Promise<void>;
  reconcile: typeof reconcileTerminalAgentBrowserSessions;
}

export const TERMINAL_BROWSER_RELEASE_LEASE_KEY = 'scheduled-job:terminal-browser-release';
const TERMINAL_BROWSER_RELEASE_LEASE_TYPE = 'TERMINAL_BROWSER_RELEASE_JOB_LEASE';
const TERMINAL_BROWSER_RELEASE_LEASE_MS = 5 * 60 * 1000;
const TERMINAL_BROWSER_RELEASE_MAX_BATCH_SIZE = 500;
const TERMINAL_BROWSER_RELEASE_MAX_RUN_MS = 50_000;

function browserSessionReleaseDependencies(retire = false): BrowserSessionReleaseDependencies {
  return {
    findActiveSessions: async (agentId: string) =>
      prisma.browserSession.findMany({
        where: {
          agentId,
          // ERROR is the durable retry marker written when a provider release
          // fails. Excluding it would turn the first transient provider outage
          // into a permanent paid-browser leak. A confirmed pause already
          // released compute; revisit it only for explicit retirement.
          status: { in: retire ? ['ACTIVE', 'PAUSED', 'ERROR'] : ['ACTIVE', 'ERROR'] },
        },
        select: { id: true, sessionId: true },
      }),
    retireUnmaterializedSession: (agentId, taskId) =>
      withSteelLifecycleClaim(taskId, async (_assertOwned, _runNative, mutateOwned) =>
        mutateOwned(async (transaction) => {
          const retired = await transaction.browserSession.updateMany({
            where: {
              id: taskId,
              agentId,
              logicalOwnerKey: `agent:${agentId}`,
              sessionId: null,
              status: 'PAUSED',
            },
            data: { status: 'CLOSED', closedAt: new Date() },
          });
          return retired.count === 1;
        })
      ),
    closeSession: async (sessionId, pause) => {
      await closeSession(sessionId, pause);
    },
  };
}

function codeSessionReleaseDependencies(): CodeSessionReleaseDependencies {
  return {
    findActiveCodeSessions: async (agentId: string) =>
      prisma.claudeCodeSession.findMany({
        where: { agentId, status: 'ACTIVE' },
        select: { id: true, sandboxId: true },
      }),
    killSandbox: async (session) => {
      if (isLocalClaudeCodeSandboxId(session.sandboxId)) {
        await closeLocalClaudeCodeSession(session.id);
        return;
      }
      if (isLocalDeviceSandboxId(session.sandboxId)) {
        await closeLocalDeviceCodeSession(session.id, session.sandboxId);
        return;
      }
      // false means E2B no longer has the sandbox, which is as released as a kill.
      await Sandbox.kill(session.sandboxId, { apiKey: process.env.E2B_API_KEY });
    },
    markClosed: async (sessionId: string) => {
      await prisma.claudeCodeSession.update({
        where: { id: sessionId },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
    },
  };
}

function terminalBrowserReleaseDependencies(): TerminalBrowserReleaseDependencies {
  return {
    findTerminalAgentIds: async (batchSize) => {
      const agents = await prisma.$queryRaw<Array<{ agentId: string }>>(Prisma.sql`
        SELECT DISTINCT browser_session."agentId" AS "agentId"
        FROM "BrowserSession" AS browser_session
        INNER JOIN "Agent" AS agent ON agent.id = browser_session."agentId"
        WHERE browser_session.status::text IN ('ACTIVE', 'ERROR')
          AND agent.status::text IN ('COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED')
        ORDER BY browser_session."agentId" ASC
        LIMIT ${batchSize}
      `);
      return agents.map((agent) => agent.agentId);
    },
    // Retry with the same policy as the terminal transition: a root's
    // completion tears its sessions down, a child's only pauses them.
    releaseBrowserSessions: async (agentId, overrides) => {
      const agent = await prisma.agent.findUnique({
        where: { id: agentId },
        select: { parentAgentId: true },
      });
      return releaseAgentBrowserSessions(agentId, overrides, {
        retire: agent !== null && agent.parentAgentId === null,
      });
    },
  };
}

/**
 * Retry browser releases for terminal agents independently of workflow liveness.
 * COMPLETED and FAILED agents are intentionally absent from liveness scans, so a
 * failed terminal-transition release needs its own durable retry path.
 */
export async function reconcileTerminalAgentBrowserSessions(
  overrides: Partial<TerminalBrowserReleaseDependencies> = {},
  options: TerminalBrowserReleaseOptions = {}
): Promise<TerminalBrowserReleaseSummary> {
  const dependencies = { ...terminalBrowserReleaseDependencies(), ...overrides };
  const startedAtMs = Date.now();
  const batchSize = Math.min(
    TERMINAL_BROWSER_RELEASE_MAX_BATCH_SIZE,
    Math.max(1, Math.floor(options.batchSize ?? 100))
  );
  const deadlineAtMs = Math.min(
    options.deadlineAtMs ?? startedAtMs + TERMINAL_BROWSER_RELEASE_MAX_RUN_MS,
    startedAtMs + TERMINAL_BROWSER_RELEASE_MAX_RUN_MS
  );
  const agentIds = await dependencies.findTerminalAgentIds(batchSize);
  let released = 0;
  let failed = 0;
  let next = 0;
  const workerCount = Math.min(8, agentIds.length);

  const workerResults = await Promise.all(
    Array.from({ length: workerCount }, async () => {
      let workerReleased = 0;
      let workerFailed = 0;
      while (next < agentIds.length && Date.now() < deadlineAtMs) {
        const agentId = agentIds[next++];
        try {
          workerReleased += await dependencies.releaseBrowserSessions(agentId);
        } catch (error) {
          workerFailed += 1;
          log.warn(`Failed to retry browser release for terminal agent ${agentId}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { released: workerReleased, failed: workerFailed };
    })
  );
  for (const result of workerResults) {
    released += result.released;
    failed += result.failed;
  }

  return { discovered: agentIds.length, released, failed };
}

async function acquireTerminalBrowserReleaseLease(ownerId: string): Promise<boolean> {
  const now = new Date();
  const liveCutoff = new Date(now.getTime() - TERMINAL_BROWSER_RELEASE_LEASE_MS);
  const expiresAt = new Date(now.getTime() + TERMINAL_BROWSER_RELEASE_LEASE_MS);
  const rows = await prisma.$queryRaw<Array<{ externalId: string }>>(Prisma.sql`
    INSERT INTO "ToolSideEffect"
      (id, "operationKey", "operationType", status, "externalId", request, "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${TERMINAL_BROWSER_RELEASE_LEASE_KEY},
       ${TERMINAL_BROWSER_RELEASE_LEASE_TYPE}, 'STARTED', ${ownerId},
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

async function releaseTerminalBrowserReleaseLease(ownerId: string): Promise<void> {
  await prisma.toolSideEffect.updateMany({
    where: {
      operationKey: TERMINAL_BROWSER_RELEASE_LEASE_KEY,
      operationType: TERMINAL_BROWSER_RELEASE_LEASE_TYPE,
      status: 'STARTED',
      externalId: ownerId,
    },
    data: {
      status: 'RELEASED',
      response: { releasedAt: new Date().toISOString() },
    },
  });
}

function terminalBrowserReleaseLeaseDependencies(): TerminalBrowserReleaseLeaseDependencies {
  return {
    acquireLease: acquireTerminalBrowserReleaseLease,
    releaseLease: releaseTerminalBrowserReleaseLease,
    reconcile: reconcileTerminalAgentBrowserSessions,
  };
}

export async function runTerminalAgentBrowserReleaseReconcileWithLease(
  options: TerminalBrowserReleaseOptions = {},
  overrides: Partial<TerminalBrowserReleaseLeaseDependencies> = {}
): Promise<TerminalBrowserReleaseLeasedResult> {
  const dependencies = { ...terminalBrowserReleaseLeaseDependencies(), ...overrides };
  const ownerId = randomUUID();
  if (!(await dependencies.acquireLease(ownerId))) {
    return { acquired: false, summary: null };
  }
  try {
    return { acquired: true, summary: await dependencies.reconcile({}, options) };
  } finally {
    try {
      await dependencies.releaseLease(ownerId);
    } catch (error) {
      log.error('Failed to release terminal browser reconciliation lease', {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Release every browser session an agent still holds — the remote Steel/Kernel
 * browser as well as the DB row.
 *
 * This must run whenever an agent stops running, not only when a user deletes it.
 * Deletion is an action most agents never receive, so hanging release off deletion
 * alone left a rented browser running for every agent that merely finished: 12 prod
 * rows were still `ACTIVE / closedAt NULL` across COMPLETED, COST_LIMIT_REACHED and
 * FAILED agents, the oldest from 2026-07-24 (agent
 * bfcfc074-0e61-41ef-b072-23376583b85a among them).
 *
 * Every session is attempted before failures are reported. Terminal callers catch
 * the aggregate so a provider outage cannot block the status transition, while the
 * provider keeps an ERROR row and terminal-browser reconciliation retries instead
 * of falsely considering a leaked rental fully cleaned up.
 */
export async function releaseAgentBrowserSessions(
  agentId: string,
  overrides: Partial<BrowserSessionReleaseDependencies> = {},
  // Deleting an agent or completing a root retires its sessions (closeSession
  // saves signed-in state first); a child's shutdown only pauses them.
  options: { retire?: boolean } = {}
): Promise<number> {
  const dependencies = { ...browserSessionReleaseDependencies(options.retire), ...overrides };
  let released = 0;
  const failures: unknown[] = [];
  let activeBrowserSessions: Array<{ id?: string; sessionId: string | null }>;
  try {
    activeBrowserSessions = await dependencies.findActiveSessions(agentId);
  } catch (error) {
    log.warn(`Failed to query browser sessions for agent ${agentId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (activeBrowserSessions.length > 0) {
    log.info(`Closing ${activeBrowserSessions.length} browser session(s) for agent ${agentId}`);
  }

  for (const session of activeBrowserSessions) {
    try {
      if (session.sessionId === null) {
        if (options.retire === true) {
          if (
            session.id === undefined ||
            !(await dependencies.retireUnmaterializedSession(agentId, session.id))
          )
            throw new Error('Unmaterialized browser binding changed during retirement');
          released += 1;
        }
        continue;
      }
      await dependencies.closeSession(session.sessionId, options.retire !== true);
      released += 1;
      log.info(`Closed browser session ${session.sessionId}`);
    } catch (error) {
      failures.push(error);
      log.warn(`Failed to close browser session ${session.sessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to close ${failures.length} browser session(s) for agent ${agentId}`
    );
  }
  return released;
}

/**
 * Clean up all active E2B sandboxes and browser sessions for an agent.
 * Called during agent deletion. Best-effort: errors are logged but never thrown.
 */
export async function cleanupAgentSessions(agentId: string): Promise<void> {
  try {
    await cleanupAgentPurchaseCards(agentId);
  } catch (error) {
    log.warn(`Failed to clean up purchase cards for agent ${agentId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await releaseAgentBrowserSessions(agentId, {}, { retire: true });
  } catch (error) {
    log.warn(`Failed to release browser sessions for agent ${agentId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await releaseAgentCodeSessions(agentId);
  } catch (error) {
    log.warn(`Failed to query E2B sessions for agent ${agentId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Kill every code sandbox (E2B or local) an agent still holds and close its row.
 *
 * The Python code-agent activity closes its own sandbox, but it cannot when its
 * worker is dead, and a replaced workflow never schedules the retry that would
 * reattach to it. Without this the old Claude Code CLI keeps working next to the
 * replacement run until E2B's own timeout.
 *
 * A failed kill leaves the row ACTIVE so the next release of this agent (another
 * cutover, descendant cleanup, deletion) retries it. Throws only when the lookup
 * itself fails.
 */
export async function releaseAgentCodeSessions(
  agentId: string,
  overrides: Partial<CodeSessionReleaseDependencies> = {}
): Promise<number> {
  const dependencies = { ...codeSessionReleaseDependencies(), ...overrides };
  const activeCodeSessions = await dependencies.findActiveCodeSessions(agentId);
  if (activeCodeSessions.length > 0) {
    log.info(`Killing ${activeCodeSessions.length} code sandbox(es) for agent ${agentId}`);
  }

  let released = 0;
  for (const session of activeCodeSessions) {
    try {
      await dependencies.killSandbox(session);
      log.info(`Killed code sandbox ${session.sandboxId}`);
    } catch (error) {
      log.warn(`Failed to kill code sandbox ${session.sandboxId}; leaving it ACTIVE for retry`, {
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    try {
      await dependencies.markClosed(session.id);
      released += 1;
    } catch (dbError) {
      log.warn(`Failed to update code session DB status ${session.id}`, {
        error: dbError instanceof Error ? dbError.message : String(dbError),
      });
    }
  }
  return released;
}

/**
 * Release what a terminated workflow's activities rented for one agent: browser
 * sessions and code sandboxes. Temporal `terminate()` does not stop in-flight
 * activities, a dead worker cannot run their own cleanup, and a replacement
 * never reattaches to them. Callers that terminate a workflow without going
 * through `updateAgentStatus`'s terminal hook must call this.
 *
 * Never throws: a provider outage must not block a cutover. 10k agents: one
 * query + one release per resource owned by the ONE agent being terminated.
 */
export async function releaseTerminatedWorkflowResources(
  agentId: string,
  caller: string
): Promise<void> {
  const releases = [
    ['browser', releaseAgentBrowserSessions],
    ['code sandbox', releaseAgentCodeSessions],
  ] as const;
  for (const [resource, release] of releases) {
    try {
      await release(agentId);
    } catch (error) {
      log.warn(`${caller} ${resource} release unavailable`, {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
