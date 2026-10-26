import { Router, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import {
  plannerMemoryCompressionClaimSchema,
  plannerMemoryCompressionReleaseSchema,
  plannerMemoryCriticalPathSchema,
  plannerMemoryEmbedPendingSchema,
  plannerMemorySearchSchema,
  plannerMemoryUpsertSchema,
} from './types';

const router = Router();

function serialize(row: NonNullable<Awaited<ReturnType<typeof service.get>>>) {
  return {
    id: row.id,
    user_id: row.userId,
    goal: row.goal,
    benchmark_task_name: row.benchmarkTaskName,
    root_status: row.rootStatus,
    passed: row.passed,
    world_model_mode: row.worldModelMode,
    agent_created_at: row.agentCreatedAt ? row.agentCreatedAt.toISOString() : null,
    archived_at: row.archivedAt.toISOString(),
    critical_path: row.criticalPath ?? null,
    compressor_version: row.compressorVersion,
    compressed_at: row.compressedAt ? row.compressedAt.toISOString() : null,
  };
}

/** Semantic retrieval over the finalized-run history for one planner call. */
router.post(
  '/search',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const parsed = plannerMemorySearchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid search body', details: parsed.error.flatten() });
      return;
    }
    // A non-internal caller may only search its own visibility scope.
    const body = parsed.data;
    if (req.isInternal !== true) {
      body.user_id = req.user?.id;
    }
    res.json(await service.search(body));
  })
);

/** Internal only: embed rows that lack a current-model embedding (backfill / repair). */
router.post(
  '/embed-pending',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Planner memory writes are internal only' });
      return;
    }
    const parsed = plannerMemoryEmbedPendingSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid embed body', details: parsed.error.flatten() });
      return;
    }
    res.json(await service.embedPending(parsed.data));
  })
);

router.get(
  '/stats',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Planner memory stats are internal only' });
      return;
    }
    res.json(await service.stats());
  })
);

router.get(
  '/:id',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const row = await service.get(String(req.params.id));
    if (row === null) {
      res.status(404).json({ error: 'Planner memory not found' });
      return;
    }
    if (req.isInternal !== true && !service.visibleTo(row, req.user?.id)) {
      res.status(404).json({ error: 'Planner memory not found' });
      return;
    }
    res.json(serialize(row));
  })
);

/** Internal only: benchmark fixtures + history backfill write rows directly. */
router.put(
  '/:id',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Planner memory writes are internal only' });
      return;
    }
    const parsed = plannerMemoryUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid planner memory body', details: parsed.error.flatten() });
      return;
    }
    const row = await service.upsert(String(req.params.id), parsed.data);
    res.json(row === null ? null : serialize(row));
  })
);

/** Internal only: atomically elect one lazy compressor for this history row. */
router.post(
  '/:id/critical-path-claim',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Planner memory writes are internal only' });
      return;
    }
    const parsed = plannerMemoryCompressionClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid compression claim', details: parsed.error.flatten() });
      return;
    }
    const claim = await service.claimCompression(String(req.params.id), parsed.data);
    if (claim.claimed === true) {
      res.status(200).json(claim);
      return;
    }
    res.status(claim.reason === 'missing' ? 404 : 200).json(claim);
  })
);

/** Internal only: release a failed compressor's lease for immediate retry. */
router.delete(
  '/:id/critical-path-claim',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Planner memory writes are internal only' });
      return;
    }
    const parsed = plannerMemoryCompressionReleaseSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid compression release', details: parsed.error.flatten() });
      return;
    }
    res.json({ released: await service.releaseCompression(String(req.params.id), parsed.data) });
  })
);

/** Cache fill accepted only from the current atomic compression lease owner. */
router.patch(
  '/:id/critical-path',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Planner memory writes are internal only' });
      return;
    }
    const parsed = plannerMemoryCriticalPathSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid critical path body', details: parsed.error.flatten() });
      return;
    }
    const row = await service.setCriticalPath(String(req.params.id), parsed.data);
    if (row === null) {
      const existing = await service.get(String(req.params.id));
      res.status(existing === null ? 404 : 409).json({
        error: existing === null ? 'Planner memory not found' : 'Compression lease is not current',
      });
      return;
    }
    res.json(serialize(row));
  })
);

/** Internal only: benchmark/bench cleanup of fixture rows. */
router.delete(
  '/:id',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Planner memory writes are internal only' });
      return;
    }
    const deleted = await service.remove(String(req.params.id));
    res.json({ deleted });
  })
);

export default router;
