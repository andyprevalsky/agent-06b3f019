/**
 * Last-resort recovery after handleChatMessage rejects.
 *
 * Router and generator already regenerate in place on empty / parse /
 * deadline structured-output misses. This hook only runs after that
 * budget is exhausted (or on a non-retryable failure). Create-agent
 * used to call failAgentIfStillActive — that is forbidden for this
 * class. Persist the notice and leave the agent ACTIVE.
 */

import { createMessage } from '../messages';
import { createLogger } from '../logger';
import { alertError } from '../errorAlert';

const log = createLogger('Agents');

export const CHAT_HANDLER_FAILURE_NOTICE =
  "Sorry — I couldn't generate a response just now. Please try again.";

export async function recoverChatHandlerFailure(params: {
  agentId: string;
  userId?: string;
  error: unknown;
  persistNotice?: () => Promise<void>;
}): Promise<void> {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  log.error('Chat handler error', {
    agent_id: params.agentId,
    error: message,
  });
  if (params.userId) {
    alertError({
      source: 'chat',
      message,
      agentId: params.agentId,
      userId: params.userId,
      stack: params.error instanceof Error ? params.error.stack : undefined,
    });
  }
  try {
    if (params.persistNotice) {
      await params.persistNotice();
      return;
    }
    await createMessage({
      agentId: params.agentId,
      role: 'ASSISTANT',
      text: CHAT_HANDLER_FAILURE_NOTICE,
      metadata: { error: true, source: 'chat_handler_failure' },
    });
  } catch (persistErr: unknown) {
    log.error('Failed to persist chat-failure notice', {
      agent_id: params.agentId,
      error: persistErr instanceof Error ? persistErr.message : String(persistErr),
    });
  }
}
