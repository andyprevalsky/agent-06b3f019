/** Explicit account endpoints; never change the scope of existing tree routes. */
import type { Request, RequestHandler, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { listAccountAgents, readAccountAgent, requireAccountAccess } from './agentAccountService';
import { spawnAccountAgent } from './agentAccountSpawnService';
import { sendGraphMessage } from './agentGraphSendService';
import { AgentGraphError, type GraphCaller } from './agentGraphService';

const pageSchema = z
  .object({
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const listSchema = pageSchema.extend({
  project: z.string().uuid().optional(),
  folder: z.string().uuid().optional(),
});
const readSchema = pageSchema.extend({
  message: z.string().uuid().optional(),
  offset: z.coerce.number().int().min(0).max(2147483646).optional(),
});
const spawnSchema = z
  .object({
    project: z.string().uuid(),
    folder: z.string().uuid(),
    title: z.string().trim().min(1).max(160),
    goal: z.string().min(1).max(100_000),
    id: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+$/),
    instruction: z
      .object({
        path: z.string().min(1).max(512),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        explicitly_authorized: z.literal(true),
      })
      .strict(),
  })
  .strict();
const sendSchema = z
  .object({
    to: z.string().uuid(),
    text: z.string().min(1).max(20_000),
    message_id: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();

export function mountAccountAgentRoutes(
  router: Router,
  auth: RequestHandler,
  caller: (req: Request) => GraphCaller
): void {
  // Default off until the independently tested Rose repair-agent migration.
  router.use('/account', (_req, res, next) => {
    if (process.env.ROSE_ACCOUNT_AGENTS_ENABLED !== 'true') {
      res.status(404).json({ error: 'Rose account-agent commands are disabled' });
      return;
    }
    next();
  });
  const handle = (fn: (req: Request, who: GraphCaller) => Promise<unknown>) =>
    asyncHandler(async (req, res) => {
      try {
        res.json(await fn(req, caller(req)));
      } catch (err) {
        if (err instanceof AgentGraphError) {
          if (err.retryAfterSeconds !== undefined)
            res.setHeader('Retry-After', err.retryAfterSeconds);
          res.status(err.status).json({ error: err.message });
        } else if (err instanceof z.ZodError)
          res.status(400).json({ error: 'Invalid account-agent request', details: err.issues });
        else throw err;
      }
    });
  router.get(
    '/account/agents',
    auth,
    handle((req, who) => listAccountAgents(who, listSchema.parse(req.query)))
  );
  router.get(
    '/account/agents/:id',
    auth,
    handle((req, who) =>
      readAccountAgent(who, z.string().uuid().parse(req.params.id), readSchema.parse(req.query))
    )
  );
  router.post(
    '/account/messages',
    auth,
    handle((req, who) => {
      requireAccountAccess(who);
      return sendGraphMessage(who, sendSchema.parse(req.body), 'message', true);
    })
  );
  router.post(
    '/account/spawn',
    auth,
    handle((req, who) => spawnAccountAgent(who, spawnSchema.parse(req.body)))
  );
}
