/**
 * Data routes - grep/search over user's local data (message threads, etc.)
 *
 * POST /api/data/grep   - Search message threads by keyword pattern
 * GET  /api/data/summary - Get filesystem-like summary of available data sources
 */

import { Router, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  grep,
  getSummary,
  InvalidPatternError,
  SourceNotFoundError,
  PersonNotFoundError,
  InvalidSinceError,
} from './service';
import { grepAgentNetwork, MissingAgentIdError, AgentNotFoundError } from './agentNetworkService';
import { grepNetwork, InvalidNetworkPatternError } from './networkService';
import { createLogger } from '../../providers/logger';

const log = createLogger('Data');
const router = Router();

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

      // Dispatch sources to dedicated handlers
      const source = req.body.source as string | undefined;
      const isAgentNetwork =
        source === 'agent_network_user_messages' || source === 'agent_network_tool_results';
      const isNetwork = source === 'network';

      const result = isAgentNetwork
        ? await grepAgentNetwork(userId, req.body)
        : isNetwork
          ? await grepNetwork(userId, req.body)
          : await grep(userId, req.body);

      const elapsed = Date.now() - startTime;
      log.info(`grep [${elapsed}ms]`);

      res.json(result);
    } catch (error) {
      const elapsed = Date.now() - startTime;

      if (error instanceof InvalidPatternError || error instanceof InvalidNetworkPatternError) {
        res.status(400).json({ error: 'INVALID_PATTERN', message: error.message });
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
      if (error instanceof PersonNotFoundError) {
        res.status(400).json({ error: 'PERSON_NOT_FOUND', message: error.message });
        return;
      }
      if (error instanceof InvalidSinceError) {
        res.status(400).json({ error: 'INVALID_SINCE', message: error.message });
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

export default router;
