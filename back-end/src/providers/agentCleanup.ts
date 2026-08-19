import { Sandbox } from 'e2b';
import { prisma } from './database';
import { createLogger } from './logger';
import { cleanupAgentPurchaseCards } from './purchaseCleanup';
import { closeSession } from './browser';

const log = createLogger('Cleanup');

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
 * Best-effort: errors are logged, never thrown, so a provider outage can never block
 * an agent from reaching its terminal state.
 */
export async function releaseAgentBrowserSessions(agentId: string): Promise<number> {
  let released = 0;
  try {
    const activeBrowserSessions = await prisma.browserSession.findMany({
      where: {
        agentId,
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
      select: { sessionId: true },
    });

    if (activeBrowserSessions.length > 0) {
      log.info(`Closing ${activeBrowserSessions.length} browser session(s) for agent ${agentId}`);
    }

    for (const session of activeBrowserSessions) {
      try {
        await closeSession(session.sessionId, false);
        released += 1;
        log.info(`Closed browser session ${session.sessionId}`);
      } catch (error) {
        log.warn(`Failed to close browser session ${session.sessionId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    log.warn(`Failed to query browser sessions for agent ${agentId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
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

  await releaseAgentBrowserSessions(agentId);

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
