/**
 * Direct chat with a running code agent (Rose-builds-Rose C7).
 *
 * `agentScopedRouter`, mounted at `/api/agents` in server.ts ahead of the agents router:
 *   POST /api/agents/:id/code-agent/:taskId/messages  - the owner types a turn to the CLI
 *   POST /api/agents/:id/code-agent/:taskId/hand-back - the owner hands the CLI back to Rose
 * `sessionScopedRouter`, mounted at `/api/claude-code-session` (the route the UI calls):
 *   POST /api/claude-code-session/:taskId/turns
 *   POST /api/claude-code-session/:taskId/hand-back
 *
 * `:id` is the agent that spawned the code agent (the session's owner row),
 * `:taskId` the code session id (`task_id` on the chip's messages). Both
 * routers run the same owner-checked, idempotent service.
 */
import { type Response, Router } from 'express';
import { createLogger } from '../../providers/logger';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  DirectChatError,
  handBackDirectChat,
  sendDirectTurn,
  getDirectChatCapabilities,
} from './directChatService';
import { directTurnSchema } from './types';

const log = createLogger('ClaudeCodeDirectChatRoutes');
const router = Router();
export const sessionScopedRouter = Router();

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
function turnHandler(agentIdParam: string | null) {
  return asyncHandler(async (req: HybridAuthRequest, res: Response) => {
    const parsed = directTurnSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid direct message', code: 'INVALID_DIRECT_TURN' });
      return;
    }
    try {
      const result = await sendDirectTurn({
        agentId: agentIdParam === null ? undefined : req.params[agentIdParam],
        taskId: req.params.taskId,
        userId: req.userId,
        clientMessageId: parsed.data.client_message_id,
        text: parsed.data.text,
        attachments: parsed.data.attachments,
        settings: {
          model: parsed.data.model,
          effort: parsed.data.reasoning_effort,
          speed: parsed.data.speed,
        },
        toolCallId: parsed.data.tool_call_id,
      });
      res.json(result);
    } catch (error) {
      sendDirectChatError(res, error, 'deliver direct message');
    }
  });
}

function handBackHandler(agentIdParam: string | null) {
  return asyncHandler(async (req: HybridAuthRequest, res: Response) => {
    try {
      res.json(
        await handBackDirectChat({
          agentId: agentIdParam === null ? undefined : req.params[agentIdParam],
          taskId: req.params.taskId,
          userId: req.userId,
        })
      );
    } catch (error) {
      sendDirectChatError(res, error, 'hand back code agent');
    }
  });
}

const auth = asyncHandler<HybridAuthRequest>(hybridAuth);
router.post('/:id/code-agent/:taskId/messages', auth, turnHandler('id'));

/** End the owner's direct-chat hold so the code agent can finish and report back. Idempotent. */
router.post('/:id/code-agent/:taskId/hand-back', auth, handBackHandler('id'));

sessionScopedRouter.post('/:taskId/turns', auth, turnHandler(null));
sessionScopedRouter.post('/:taskId/hand-back', auth, handBackHandler(null));

export default router;

sessionScopedRouter.get(
  '/:taskId/capabilities',
  auth,
  asyncHandler(async (req: HybridAuthRequest, res: Response) => {
    try {
      res.json(await getDirectChatCapabilities({ taskId: req.params.taskId, userId: req.userId }));
    } catch (error) {
      sendDirectChatError(res, error, 'read code session capabilities');
    }
  })
);
