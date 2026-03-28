import { Sandbox } from 'e2b';
import { prisma } from './database';
import { closeSession } from './steel';

/**
 * Clean up all active E2B sandboxes and Steel browser sessions for an agent.
 * Called during agent deletion. Best-effort: errors are logged but never thrown.
 */
export async function cleanupAgentSessions(agentId: string): Promise<void> {
  // --- Steel browser sessions ---
  try {
    const activeBrowserSessions = await prisma.browserSession.findMany({
      where: {
        agentId,
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
      select: { sessionId: true },
    });

    if (activeBrowserSessions.length > 0) {
      console.log(
        `[Cleanup] Closing ${activeBrowserSessions.length} Steel session(s) for agent ${agentId}`
      );
    }

    for (const session of activeBrowserSessions) {
      try {
        await closeSession(session.sessionId, false);
        console.log(`[Cleanup] Closed Steel session ${session.sessionId}`);
      } catch (error) {
        console.warn(
          `[Cleanup] Failed to close Steel session ${session.sessionId}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  } catch (error) {
    console.warn(
      `[Cleanup] Failed to query Steel sessions for agent ${agentId}:`,
      error instanceof Error ? error.message : String(error)
    );
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
      console.log(
        `[Cleanup] Killing ${activeCodeSessions.length} E2B sandbox(es) for agent ${agentId}`
      );
    }

    for (const session of activeCodeSessions) {
      try {
        const sandbox = await Sandbox.connect(session.sandboxId, {
          apiKey: process.env.E2B_API_KEY,
        });
        await sandbox.kill();
        console.log(`[Cleanup] Killed E2B sandbox ${session.sandboxId}`);
      } catch (error) {
        console.warn(
          `[Cleanup] Failed to kill E2B sandbox ${session.sandboxId}:`,
          error instanceof Error ? error.message : String(error)
        );
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
        console.warn(
          `[Cleanup] Failed to update E2B session DB status ${session.id}:`,
          dbError instanceof Error ? dbError.message : String(dbError)
        );
      }
    }
  } catch (error) {
    console.warn(
      `[Cleanup] Failed to query E2B sessions for agent ${agentId}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}
