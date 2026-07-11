import { Sandbox } from 'e2b';
import { prisma } from './database';
import { createLogger } from './logger';
import { cleanupAgentPurchaseCards } from './purchaseCleanup';
import { closeSession } from './browser';

const log = createLogger('Cleanup');

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

  // --- Browser sessions ---
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
