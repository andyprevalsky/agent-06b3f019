import { type NextFunction, type Response, Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as hubStore from '../../providers/benchmarkHubStore';
import { BENCHMARK_HUB_ADMIN_USER_IDS } from './config';
import * as service from './service';
import { TaskNotFoundError, TasksUnavailableError, UnknownTasksError } from './service';

const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

/**
 * Hub access gate: the internal API key (uploader/poller) or an authed user
 * on the team allowlist. Everything the hub exposes — catalog edits, run
 * transcripts, dispatch — is internal-team tooling, never end-user data.
 */
function requireHubAdmin(req: HybridAuthRequest, res: Response, next: NextFunction): void {
  if (req.isInternal === true) {
    next();
    return;
  }
  if (req.userId && BENCHMARK_HUB_ADMIN_USER_IDS.has(req.userId)) {
    next();
    return;
  }
  res.status(403).json({ error: 'Benchmark hub access is restricted' });
}

/** Uploader/poller-only gate (internal API key). */
function requireInternal(req: HybridAuthRequest, res: Response, next: NextFunction): void {
  if (req.isInternal === true) {
    next();
    return;
  }
  res.status(403).json({ error: 'Internal API key required' });
}

/**
 * GET /api/benchmarks
 * Returns benchmark task definitions from agents/benchmarks/tasks.json.
 * No auth required — task definitions are not sensitive.
 */
router.get('/', (req, res) => {
  try {
    const tasks = service.getTasks();
    res.json({ tasks });
  } catch (error) {
    if (error instanceof TasksUnavailableError) {
      res.status(500).json({ error: 'Benchmark tasks unavailable' });
      return;
    }
    throw error;
  }
});

/**
 * GET /api/benchmarks/test-prompts
 * Catalog entries adapted for the front-end test-prompts picker (dev query box).
 * No auth required — same public data as GET /api/benchmarks, reshaped.
 */
router.get('/test-prompts', (req, res) => {
  try {
    const prompts = service.getTestPrompts();
    res.json({ prompts });
  } catch (error) {
    if (error instanceof TasksUnavailableError) {
      res.status(500).json({ error: 'Benchmark tasks unavailable' });
      return;
    }
    throw error;
  }
});

// ── Benchmark Hub endpoints (team-gated) ────────────────────────────────────

/** GET /api/benchmarks/tasks — full catalog from the DB + per-task stats. */
router.get(
  '/tasks',
  auth,
  requireHubAdmin,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    res.json({ tasks: await service.getCatalog() });
  })
);

/** PATCH /api/benchmarks/tasks/:name — validated metadata edit. */
router.patch(
  '/tasks/:name',
  auth,
  requireHubAdmin,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const parsed = service.taskEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid task edit', details: parsed.error.flatten() });
      return;
    }
    try {
      const task = await service.patchTask(
        req.params.name,
        parsed.data,
        req.userId ?? 'internal'
      );
      res.json({ task });
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      throw error;
    }
  })
);

/** POST /api/benchmarks/run-requests — dispatch selected tasks. */
router.post(
  '/run-requests',
  auth,
  requireHubAdmin,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const parsed = service.runRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid run request', details: parsed.error.flatten() });
      return;
    }
    try {
      const request = await service.createRunRequest(parsed.data, req.userId ?? 'internal');
      res.status(201).json({ request });
    } catch (error) {
      if (error instanceof UnknownTasksError) {
        res.status(400).json({ error: error.message, unknown_tasks: error.unknown });
        return;
      }
      throw error;
    }
  })
);

/** GET /api/benchmarks/run-requests?status=queued,running — queue view. */
router.get(
  '/run-requests',
  auth,
  requireHubAdmin,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const statusParam = typeof req.query.status === 'string' ? req.query.status : '';
    const statuses = statusParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    res.json({ requests: await service.listRunRequests(statuses) });
  })
);

/** PATCH /api/benchmarks/run-requests/:id — poller claim/progress/complete. */
router.patch(
  '/run-requests/:id',
  auth,
  requireInternal,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const parsed = service.runRequestUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid update', details: parsed.error.flatten() });
      return;
    }
    const request = await service.updateRunRequest(req.params.id, parsed.data);
    if (request === null) {
      res.status(409).json({ error: 'Request not found or not claimable' });
      return;
    }
    res.json({ request });
  })
);

/** POST /api/benchmarks/runs — uploader: live snapshot or final bundle. */
router.post(
  '/runs',
  auth,
  requireInternal,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.run_id !== 'string' || body.run_id === '') {
      res.status(400).json({ error: 'run_id required' });
      return;
    }
    const live = req.query.live === '1' || body.live === true;
    const summary = await hubStore.putRun(body, {
      live,
      source: typeof body.source === 'string' ? body.source : undefined,
    });
    res.status(201).json({ run: summary });
  })
);

/** GET /api/benchmarks/runs — run index (live + past, newest first). */
router.get(
  '/runs',
  auth,
  requireHubAdmin,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    res.json({ runs: await hubStore.listRuns() });
  })
);

/** GET /api/benchmarks/runs/:id — per-task detail for one run. */
router.get(
  '/runs/:id',
  auth,
  requireHubAdmin,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const runs = await hubStore.listRuns();
    const run = runs.find((r) => r.run_id === req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json({ run });
  })
);

/** DELETE /api/benchmarks/runs/:id — internal hygiene (test uploads, junk). */
router.delete(
  '/runs/:id',
  auth,
  requireInternal,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const removed = await hubStore.deleteRun(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json({ ok: true });
  })
);

/** GET /api/benchmarks/runs/:id/agents/:agentId — in-app transcript + tree. */
router.get(
  '/runs/:id/agents/:agentId',
  auth,
  requireHubAdmin,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const view = await hubStore.getRunAgent(req.params.id, req.params.agentId);
    if (view === null) {
      res.status(404).json({ error: 'Agent not found in run' });
      return;
    }
    res.json(view);
  })
);

export default router;
