/**
 * Read-only code inspection route (mounted on /api/claude-code-session).
 *
 * POST /code-sessions/:id/inspect {agent_id, question}   internal callers only
 *   user = X-User-Id (or body user_id); agent_id = the calling explore/root agent
 *   200 {status: answered | failed | usage_limited, answer, citations, timings, …}
 *   400 invalid body · 404 unknown or another user's session / agent
 *   409 no checkpoint yet · 503 no sandbox or code-agent credential
 *
 * The caller hanging up aborts the inspection: its sandbox is killed at once.
 * See providers/codeSessions/inspect.ts for the flow.
 */
import { type Response, type Router } from 'express';
import { E2BSandboxCapacityError } from '../../providers/e2bSandboxCreate';
import { z } from 'zod';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import {
  CodeInspectError,
  inspectCodeSession,
  MAX_INSPECT_QUESTION_CHARS,
} from '../../providers/codeSessions/inspect';
import { asyncHandler } from '../../utils/asyncHandler';

const auth = asyncHandler<HybridAuthRequest>(hybridAuth);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export const codeInspectSchema = z.object({
  agent_id: z.string().uuid(),
  question: z.string().min(1).max(MAX_INSPECT_QUESTION_CHARS),
  user_id: z.string().optional(),
});

export function registerCodeInspectRoutes(router: Router): void {
  router.post(
    '/code-sessions/:id/inspect',
    auth,
    asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
      if (req.isInternal !== true) {
        res.status(403).json({ error: 'Internal callers only' });
        return;
      }
      const userId = req.userId;
      if (userId === undefined || userId === '') {
        res.status(400).json({ error: 'X-User-Id is required', code: 'USER_ID_REQUIRED' });
        return;
      }
      if (!UUID.test(req.params.id)) {
        res.status(404).json({ error: 'Code session not found', code: 'CODE_SESSION_NOT_FOUND' });
        return;
      }
      const body = codeInspectSchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: 'Invalid body', details: body.error.issues });
        return;
      }
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      try {
        res.json(
          await inspectCodeSession({
            userId,
            agentId: body.data.agent_id,
            codeSessionId: req.params.id,
            question: body.data.question,
            signal: abort.signal,
          })
        );
      } catch (error) {
        if (error instanceof CodeInspectError) {
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        if (error instanceof E2BSandboxCapacityError) {
          res.status(error.statusCode).json({ error: error.message, code: error.code });
          return;
        }
        throw error;
      }
    })
  );
}
