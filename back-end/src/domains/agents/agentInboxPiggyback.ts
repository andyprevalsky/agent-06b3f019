import { readTaskInboxMessages } from './agentToAgentService';
import type { PostMessageBody } from './types';

/**
 * Explore progress posts carry their task's inbox read (one bounded indexed
 * query) instead of a separate per-step GET /:id/agent-inbox.
 */
export async function withPiggybackedInbox<T extends object>(
  agentId: string,
  body: PostMessageBody,
  isInternal: boolean,
  posted: T
): Promise<T & { pending_inbox?: Awaited<ReturnType<typeof readTaskInboxMessages>> }> {
  if (!isInternal || body.inbox === undefined) return posted;
  const pending = await readTaskInboxMessages(agentId, body.inbox.task_id, body.inbox.since);
  return { ...posted, pending_inbox: pending };
}
