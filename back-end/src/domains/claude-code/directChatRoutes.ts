/**
 * Direct chat with a running code agent (Rose-builds-Rose C7). Mounted at
 * `/api/agents` in server.ts, ahead of the agents router:
 *
 * POST /api/agents/:id/code-agent/:taskId/messages  - the owner types a turn to the CLI
 * POST /api/agents/:id/code-agent/:taskId/hand-back - the owner hands the CLI back to Rose
 *
 * `:id` is the agent that spawned the code agent (the session's owner row),
 * `:taskId` the code session id (`task_id` on the chip's messages).
 */
import { type Response, Router } from 'express';
import { createLogger } from '../../providers/logger';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { DirectChatError, handBackDirectChat, sendDirectTurn } from './directChatService';
import { directTurnSchema } from './types';

const log = createLogger('ClaudeCodeDirectChatRoutes');
const router = Router();

function sendDirectChatError(res: Response, error: unknown, action: string): void {
  if (error instanceof DirectChatError) {
    res.status(error.httpStatus).json({ error: error.message, code: error.code });
    return;
  }
  log.error(`Failed to ${action}`, {
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({ error: `Failed to ${action}` });
}

/**
 * Deliver a user-typed turn to the running code session's CLI. Owner only;
 * idempotent per `client_message_id` (a retry returns status "duplicate" and
 * the same `message_id`).
 */
router.post(
  '/:id/code-agent/:taskId/messages',
  asyncHandler<HybridAuthRequest>(hybridAuth),
  asyncHandler(async (req: HybridAuthRequest, res: Response) => {
    const parsed = directTurnSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid direct message', code: 'INVALID_DIRECT_TURN' });
      return;
    }
    try {
      const result = await sendDirectTurn({
        agentId: req.params.id,
        taskId: req.params.taskId,
        userId: req.userId,
        clientMessageId: parsed.data.client_message_id,
        text: parsed.data.text,
        toolCallId: parsed.data.tool_call_id,
      });
      res.json(result);
    } catch (error) {
      sendDirectChatError(res, error, 'deliver direct message');
    }
  })
);

/** End the owner's direct-chat hold so the code agent can finish and report back. Idempotent. */
router.post(
  '/:id/code-agent/:taskId/hand-back',
  asyncHandler<HybridAuthRequest>(hybridAuth),
  asyncHandler(async (req: HybridAuthRequest, res: Response) => {
    try {
      res.json(
        await handBackDirectChat({
          agentId: req.params.id,
          taskId: req.params.taskId,
          userId: req.userId,
        })
      );
    } catch (error) {
      sendDirectChatError(res, error, 'hand back code agent');
    }
  })
);

export default router;
