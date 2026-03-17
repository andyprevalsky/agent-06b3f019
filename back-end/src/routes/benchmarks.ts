import { Router } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

// Read once at startup — task definitions are static
const tasksPath = path.join(__dirname, '..', '..', '..', 'agents', 'benchmarks', 'tasks.json');
let cachedTasks: unknown[] | null = null;
try {
  cachedTasks = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
} catch (err) {
  console.error('Failed to load benchmark tasks at startup:', err);
}

/**
 * GET /api/benchmarks
 * Returns benchmark task definitions from agents/benchmarks/tasks.json.
 * No auth required — task definitions are not sensitive.
 */
router.get('/', (req, res) => {
  if (!cachedTasks) {
    res.status(500).json({ error: 'Benchmark tasks unavailable' });
    return;
  }
  res.json({ tasks: cachedTasks });
});

export default router;
