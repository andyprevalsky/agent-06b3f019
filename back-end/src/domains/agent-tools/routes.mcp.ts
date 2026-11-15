/**
 * The user's connected MCP servers for agents (code-agent sandbox token or
 * internal API key + X-User-Id). The backend proxies every call, so server
 * headers and OAuth tokens stay out of agent sandboxes.
 *
 *   GET  /:agentId/mcp                      connected servers + tool schemas
 *   POST /:agentId/mcp/:integrationId/call  {tool, arguments} → {content, is_error}
 */
import type { Router, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { callMcpTool, listAgentMcpServers, McpServerError } from '../../providers/mcp/servers';
import { asyncHandler } from '../../utils/asyncHandler';
import { resolveContext } from './service';
import type { AgentToolsCaller } from './types';
import type { HybridAuthRequest } from '../../providers/hybridAuth';

const callSchema = z
  .object({
    tool: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export function mountMcpToolRoutes<T extends HybridAuthRequest>(
  router: Router,
  agentToolsAuth: RequestHandler,
  callerFor: (req: T, res: Response) => AgentToolsCaller | null,
  sendError: (res: Response, err: unknown) => void
): void {
  const run =
    (fn: (req: T, res: Response, userId: string) => Promise<void>) =>
    async (req: T, res: Response) => {
      const caller = callerFor(req, res);
      if (caller === null) return;
      try {
        const context = await resolveContext(caller);
        res.setHeader('Cache-Control', 'no-store');
        await fn(req, res, context.agent.userId);
      } catch (error) {
        if (error instanceof McpServerError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        sendError(res, error);
      }
    };
  router.get(
    '/:agentId/mcp',
    agentToolsAuth,
    asyncHandler<T>(
      run(async (_req, res, userId) => {
        res.json(await listAgentMcpServers(userId));
      })
    )
  );
  router.post(
    '/:agentId/mcp/:integrationId/call',
    agentToolsAuth,
    asyncHandler<T>(
      run(async (req, res, userId) => {
        const parsed = callSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
          return;
        }
        const result = await callMcpTool(
          userId,
          String(req.params.integrationId),
          parsed.data.tool,
          parsed.data.arguments
        );
        res.json({
          content: result.content,
          is_error: result.isError,
          ...(result.structuredContent !== undefined
            ? { structured_content: result.structuredContent }
            : {}),
        });
      })
    )
  );
}
