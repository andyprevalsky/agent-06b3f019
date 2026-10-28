import { prisma } from '../database';
import { storedBrowserProvider, type BrowserProviderName } from './types';

/** The provider persisted on a session row: dispatch always follows it, never the default. */
export async function providerForSession(sessionId: string): Promise<BrowserProviderName> {
  const session = await prisma.browserSession.findUnique({
    where: { sessionId },
    select: { provider: true },
  });
  if (session === null) throw new Error(`Browser session not found: ${sessionId}`);
  return storedBrowserProvider(session.provider);
}

export async function providerForTask(taskId: string): Promise<BrowserProviderName> {
  const session = await prisma.browserSession.findUnique({
    where: { id: taskId },
    select: { provider: true },
  });
  if (session === null) throw new Error(`Browser task not found: ${taskId}`);
  return storedBrowserProvider(session.provider);
}
