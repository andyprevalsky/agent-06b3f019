/**
 * DEMO cache routes — thin controller.
 *
 * POST /api/fast-cache/get      { key }                       -> { hit, value, blobPath }
 * POST /api/fast-cache/get-many { keys }                      -> { results }
 * POST /api/fast-cache/get-position { goalHash, callSite, step } -> { hit, value, blobPath, key }
 * POST /api/fast-cache/set      { key, kind, goalHash, value } -> { ok }
 * POST /api/fast-cache/purge    { goalHash }                   -> { removed }
 *
 * The Python agent + browser cache call these. Gating is the caller's job: when
 * Fast Mode is off, callers never hit these routes at all.
 */

import { type Response, Router } from 'express';
import { z } from 'zod';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import {
  cacheGet,
  cacheGetMany,
  cacheGetPosition,
  cacheSetWithAck,
  cachePurge,
  agentFastMode,
} from './service';

const log = createLogger('DemoCache');
const router = Router();

const getSchema = z.object({ key: z.string().min(1) });
const getManySchema = z.object({ keys: z.array(z.string().min(1)).min(1).max(500) });
const getPositionSchema = z.object({
  goalHash: z.string().min(1),
  callSite: z.string().min(1),
  // Omit (or null) for content-addressed slots like response_schema (`:c:`).
  step: z.number().int().min(0).nullish(),
});
const setSchema = z.object({
  key: z.string().min(1),
  kind: z.enum([
    'llm',
    'browser_use',
    'browser_http',
    'web_search',
    'web_fetch',
    'file',
    'anthropic',
    'codex',
  ]),
  goalHash: z.string().min(1),
  value: z.unknown(),
  blobPath: z.string().nullish(),
});
const purgeSchema = z.object({ goalHash: z.string().min(1) });
const agentFlagSchema = z.object({ agentId: z.string().min(1) });

router.post(
  '/get',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { key } = getSchema.parse(req.body);
    const result = await cacheGet(key);
    res.json(result);
  })
);

router.post(
  '/get-many',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { keys } = getManySchema.parse(req.body);
    const results = await cacheGetMany(keys);
    res.json({ results });
  })
);

router.post(
  '/get-position',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = getPositionSchema.parse(req.body);
    const result = await cacheGetPosition(body);
    res.json(result);
  })
);

router.post(
  '/set',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = setSchema.parse(req.body);
    const stored = await cacheSetWithAck({
      key: body.key,
      kind: body.kind,
      goalHash: body.goalHash,
      value: body.value,
      blobPath: body.blobPath ?? null,
    });
    res.json({ ok: true, stored });
  })
);

router.post(
  '/purge',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { goalHash } = purgeSchema.parse(req.body);
    const removed = await cachePurge(goalHash);
    log.info('Purged fast-mode cache', { goalHash, removed });
    res.json({ removed });
  })
);

// Internal: resolve an agent's Fast Mode flag + goal by id (API-key auth, no RLS),
// so the Python agent can auto-resolve the cache context for DAG nodes / sub-agents.
router.post(
  '/agent-flag',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { agentId } = agentFlagSchema.parse(req.body);
    const result = await agentFastMode(agentId);
    res.json(result);
  })
);

export default router;
