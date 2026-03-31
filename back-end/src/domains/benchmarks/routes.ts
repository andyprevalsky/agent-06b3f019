import { Router } from 'express';
import * as service from './service';
import { TasksUnavailableError } from './service';

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
      res.status(500).json({ error: error.message });
      return;
    }
    throw error;
  }
});

export default router;
