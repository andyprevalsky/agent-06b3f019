/**
 * Shared route-layer helpers for the agents domain.
 *
 * Extracted from routes.ts so the split route modules (routes.archive.ts and
 * friends) map errors and cache headers identically instead of each growing its
 * own near-copy.
 */

import { TaskPathConflictError } from './agentTaskPath';
import { type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '../../providers/logger';
import { BenchmarkHubUnavailableError } from '../../providers/benchmarkHubErrors';
import { StaleParentWorkflowGenerationError } from '../../providers/workflowGeneration';
import { WorldModelModeAccessError } from './agentExecutionMode';
import { CodeSessionShareTargetNotFoundError } from '../../providers/codeSessions/branch';
import { AgentProjectNotFoundError } from './agentProject';

const log = createLogger('Agents');

export function noCacheHeaders(res: Response): void {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

export function handleRouteError(
  res: Response,
  error: unknown,
  msg: string,
  ctx?: Record<string, string>
): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid request body', details: error.issues });
    return;
  }
  if (error instanceof StaleParentWorkflowGenerationError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof CodeSessionShareTargetNotFoundError) {
    res.status(404).json({ error: error.message, code: 'CODE_SESSION_SHARE_TARGET_NOT_FOUND' });
    return;
  }
  if (error instanceof TaskPathConflictError) {
    res.status(409).json({ error: error.message, task_path: error.taskPath });
    return;
  }
  if (error instanceof WorldModelModeAccessError) {
    res.status(403).json({ error: error.message });
    return;
  }
  if (error instanceof AgentProjectNotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof BenchmarkHubUnavailableError) {
    res.set('Retry-After', String(error.retryAfterSeconds));
    res.status(503).json({ error: error.message });
    return;
  }
  log.error(msg, {
    ...ctx,
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({ error: msg });
}
