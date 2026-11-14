/** Published CLI templates retain their native authentication until disconnected. */
import { prisma } from './database';

export async function isCliTemplateSession(
  userId: string,
  codeSessionId: string
): Promise<boolean> {
  const row = await prisma.integration.findFirst({
    where: {
      userId,
      name: 'cli',
      type: 'TOOL_SETUP',
      config: { path: ['code_session_id'], equals: codeSessionId },
    },
    select: { id: true },
  });
  return row !== null;
}
