/**
 * Data routes - grep/search over user's local data (message threads, etc.)
 *
 * POST /api/data/grep   - Search message threads by keyword pattern
 * GET  /api/data/summary - Get filesystem-like summary of available data sources
 * GET  /api/data/project-agents - list_agents metadata for own and team-shared projects
 */

import { Router, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { getSharedDataMap } from './teamContext';
import { executeGrepTool } from './grepTool';
import { listProjectAgents, parseProjectAgentQuery } from './projectAgentSearchService';
import {
  getSnapshot,
  getSourceStatus,
  getSummary,
  InvalidPatternError,
  SourceNotFoundError,
  InvalidGrepParamError,
  MissingAgentIdError,
  AgentNotFoundError,
  AgentPathNotFoundError,
} from './service';
import { createLogger } from '../../providers/logger';

const log = createLogger('Data');
const router = Router();

router.get(
  '/team-context',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId =
      req.isInternal === true ? (req.headers['x-user-id'] as string | undefined) : req.user?.id;
    if (userId === undefined || userId === '') {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }
    res.json(await getSharedDataMap(userId));
  })
);

router.get(
  '/project-agents',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId =
      req.isInternal === true ? (req.headers['x-user-id'] as string | undefined) : req.user?.id;
    if (userId === undefined || userId === '') {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }
    try {
      res.json(await listProjectAgents(userId, parseProjectAgentQuery(req.query)));
    } catch (error) {
      if (error instanceof InvalidGrepParamError) {
        res.status(400).json({ error: `Invalid ${error.param}. ${error.hint ?? ''}`.trim() });
        return;
      }
      throw error;
    }
  })
);

/**
 * POST /api/data/grep
 *
 * Search user's local data by keyword pattern.
 * Plain text search only (no regex) — uses Postgres ILIKE with trigram index.
 *
 * TODO: Full regex support skipped for now. ILIKE + trigram indexes are fast and cover
 * the majority of use cases ("dinner", "meeting notes", "project update"). Arbitrary
 * regex (~ operator) bypasses trigram indexes and causes full table scans.
 * If we add regex later, validate the pattern server-side and set a query timeout.
 */
router.post(
  '/grep',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const startTime = Date.now();
    try {
      const userId =
        req.isInternal === true
          ? ((req.headers['x-user-id'] as string | undefined) ?? req.body.user_id)
          : req.user?.id;

      if (userId === undefined || userId === null) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const result = await executeGrepTool(userId, req.body);

      const elapsed = Date.now() - startTime;
      log.info(`grep [${elapsed}ms]`);

      res.json(result);
    } catch (error) {
      const elapsed = Date.now() - startTime;

      if (error instanceof InvalidPatternError) {
        res.status(400).json({ error: 'INVALID_PATTERN', message: error.message });
        return;
      }
      if (error instanceof InvalidGrepParamError) {
        res.status(400).json({ error: 'INVALID_GREP_PARAM', message: error.message });
        return;
      }
      if (error instanceof SourceNotFoundError) {
        res.status(400).json({
          error: 'SOURCE_NOT_FOUND',
          message: error.message,
          available_sources: error.availableSources,
        });
        return;
      }
      if (error instanceof MissingAgentIdError) {
        res.status(400).json({ error: 'MISSING_AGENT_ID', message: error.message });
        return;
      }
      if (error instanceof AgentNotFoundError) {
        res.status(403).json({ error: 'AGENT_NOT_FOUND', message: error.message });
        return;
      }
      if (error instanceof AgentPathNotFoundError) {
        res.status(404).json({ error: 'AGENT_PATH_NOT_FOUND', message: error.message });
        return;
      }

      log.error(`grep failed [${elapsed}ms]`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({
        error: 'GREP_FAILED',
        message: 'Failed to search messages. Please try again.',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

/**
 * GET /api/data/summary
 *
 * Returns a filesystem-like summary of the user's available data sources.
 * Used by the explore agent to know what local data exists and how to search it.
 */
router.get(
  '/summary',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const startTime = Date.now();
    try {
      const userId =
        req.isInternal === true ? (req.headers['x-user-id'] as string | undefined) : req.user?.id;

      if (userId === undefined || userId === null) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const result = await getSummary(userId);

      const elapsed = Date.now() - startTime;
      log.info(`summary [${elapsed}ms]`);

      res.json(result);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      log.error(`summary failed [${elapsed}ms]`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({
        error: 'Failed to fetch data summary',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

/**
 * GET /api/data/source-status?sources=email,network
 *
 * Per-source connectivity for the agent gate. For each requested source,
 * reports whether its backing connector is CONNECTED and, when not, a URL the
 * user can follow to connect it (a real Gmail OAuth start URL, a stub for
 * other connectors, or null for local sources).
 */
router.get(
  '/source-status',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const startTime = Date.now();
    try {
      const userId =
        req.isInternal === true ? (req.headers['x-user-id'] as string | undefined) : req.user?.id;

      if (userId === undefined || userId === null) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const sourcesParam = req.query.sources;
      const sources =
        typeof sourcesParam === 'string'
          ? sourcesParam
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : [];

      const statuses = await getSourceStatus(userId, sources);

      const elapsed = Date.now() - startTime;
      log.info(`source-status [${elapsed}ms] ${sources.join(',')}`);

      res.json({ statuses });
    } catch (error) {
      const elapsed = Date.now() - startTime;
      if (error instanceof SourceNotFoundError) {
        res.status(400).json({
          error: 'SOURCE_NOT_FOUND',
          message: error.message,
          available_sources: error.availableSources,
        });
        return;
      }
      log.error(`source-status failed [${elapsed}ms]`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({
        error: 'SOURCE_STATUS_FAILED',
        message: 'Failed to resolve source connectivity.',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

/**
 * GET /api/data/snapshot
 *
 * Returns the current distilled user snapshot plus a small update ledger.
 * Used by agents to inject high-signal persistent context.
 */
router.get(
  '/snapshot',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId =
      req.isInternal === true ? (req.headers['x-user-id'] as string | undefined) : req.user?.id;

    if (userId === undefined || userId === null) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    const result = await getSnapshot(userId);
    res.json(result);
  })
);

export default router;
