import { Sandbox } from 'e2b';
import { Prisma } from '@prisma/client';
import { prisma } from './database';
import { createLogger } from './logger';
import { cleanupAgentPurchaseCards } from './purchaseCleanup';
import { closeSession } from './browser';

const log = createLogger('Cleanup');

export interface BrowserSessionReleaseDependencies {
  findActiveSessions: (agentId: string) => Promise<Array<{ sessionId: string }>>;
  closeSession: (sessionId: string, pause: boolean) => Promise<void>;
}

export interface TerminalBrowserReleaseDependencies {
  findTerminalAgentIds: () => Promise<string[]>;
  releaseBrowserSessions: typeof releaseAgentBrowserSessions;
}

export interface TerminalBrowserReleaseSummary {
  discovered: number;
  released: number;
  failed: number;
}

function browserSessionReleaseDependencies(): BrowserSessionReleaseDependencies {
  return {
    findActiveSessions: async (agentId: string) =>
      prisma.browserSession.findMany({
        where: {
          agentId,
          // ERROR is the durable retry marker written when a provider release
          // fails. Excluding it would turn the first transient provider outage
          // into a permanent paid-browser leak.
          status: { in: ['ACTIVE', 'PAUSED', 'ERROR'] },
        },
        select: { sessionId: true },
      }),
    closeSession,
  };
}

function terminalBrowserReleaseDependencies(): TerminalBrowserReleaseDependencies {
  return {
    findTerminalAgentIds: async () => {
      const agents = await prisma.$queryRaw<Array<{ agentId: string }>>(Prisma.sql`
        SELECT DISTINCT browser_session."agentId" AS "agentId"
        FROM "BrowserSession" AS browser_session
        INNER JOIN "Agent" AS agent ON agent.id = browser_session."agentId"
        WHERE browser_session.status::text IN ('ACTIVE', 'PAUSED', 'ERROR')
          AND agent.status::text IN ('COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED')
      `);
      return agents.map((agent) => agent.agentId);
    },
    releaseBrowserSessions: releaseAgentBrowserSessions,
  };
}

/**
 * Retry browser releases for terminal agents independently of workflow liveness.
 * COMPLETED and FAILED agents are intentionally absent from liveness scans, so a
 * failed terminal-transition release needs its own durable retry path.
 */
export async function reconcileTerminalAgentBrowserSessions(
  overrides: Partial<TerminalBrowserReleaseDependencies> = {}
): Promise<TerminalBrowserReleaseSummary> {
  const dependencies = { ...terminalBrowserReleaseDependencies(), ...overrides };
  const agentIds = await dependencies.findTerminalAgentIds();
  let released = 0;
  let failed = 0;
  let next = 0;
  const workerCount = Math.min(8, agentIds.length);

  const workerResults = await Promise.all(
    Array.from({ length: workerCount }, async () => {
      let workerReleased = 0;
      let workerFailed = 0;
      while (next < agentIds.length) {
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
  overrides: Partial<BrowserSessionReleaseDependencies> = {}
): Promise<number> {
  const dependencies = { ...browserSessionReleaseDependencies(), ...overrides };
  let released = 0;
  const failures: unknown[] = [];
  let activeBrowserSessions: Array<{ sessionId: string }>;
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
      await dependencies.closeSession(session.sessionId, false);
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
    await releaseAgentBrowserSessions(agentId);
  } catch (error) {
    log.warn(`Failed to release browser sessions for agent ${agentId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // --- E2B Claude Code sessions ---
  try {
    const activeCodeSessions = await prisma.claudeCodeSession.findMany({
      where: {
        agentId,
        status: 'ACTIVE',
      },
      select: { id: true, sandboxId: true },
    });

    if (activeCodeSessions.length > 0) {
      log.info(`Killing ${activeCodeSessions.length} E2B sandbox(es) for agent ${agentId}`);
    }

    for (const session of activeCodeSessions) {
      try {
        const sandbox = await Sandbox.connect(session.sandboxId, {
          apiKey: process.env.E2B_API_KEY,
        });
        await sandbox.kill();
        log.info(`Killed E2B sandbox ${session.sandboxId}`);
      } catch (error) {
        log.warn(`Failed to kill E2B sandbox ${session.sandboxId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        await prisma.claudeCodeSession.update({
          where: { id: session.id },
          data: {
            status: 'CLOSED',
            closedAt: new Date(),
          },
        });
      } catch (dbError) {
        log.warn(`Failed to update E2B session DB status ${session.id}`, {
          error: dbError instanceof Error ? dbError.message : String(dbError),
        });
      }
    }
  } catch (error) {
    log.warn(`Failed to query E2B sessions for agent ${agentId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
