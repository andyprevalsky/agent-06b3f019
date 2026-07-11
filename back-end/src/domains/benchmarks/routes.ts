import { Router } from 'express';
import * as service from './service';
import { TasksUnavailableError } from './service';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

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

/**
 * GET /api/benchmarks/agent-preview/:id
 * Benchmark-only retained-run preview used by public FE verification links.
 */
router.get(
  '/agent-preview/:id',
  asyncHandler(async (req, res) => {
    try {
      const result = await service.getBenchmarkAgentPreview(req.params.id);
      if (result === null) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json(result);
    } catch {
      res.status(500).json({ error: 'Failed to fetch benchmark agent preview' });
    }
  })
);

export default router;
