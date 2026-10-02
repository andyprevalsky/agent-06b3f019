import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import { authTestSiteEnabled } from './config';
import {
  buildReport,
  createAuthTestSite,
  deleteAuthTestSite,
  isFixtureApiKey,
  markRun,
} from './service';
import { pagesRouter } from './routesPages';
import { AUTH_TEST_SITE_SCENARIOS, AuthTestSiteError, type AuthTestSiteScenario } from './types';

const log = createLogger('AuthTestSite');
const router = Router();

router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!authTestSiteEnabled()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
});

function requireFixtureApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-api-key'];
  if (!isFixtureApiKey(typeof header === 'string' ? header : undefined)) {
    res.status(403).json({ error: 'Internal API key required' });
    return;
  }
  next();
}

function respondError(res: Response, error: unknown, context: Record<string, unknown>): void {
  if (error instanceof AuthTestSiteError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  log.error('Auth test site fixture request failed', {
    ...context,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  res.status(500).json({ error: 'Auth test site fixture request failed' });
}

function isScenario(value: unknown): value is AuthTestSiteScenario {
  return (
    typeof value === 'string' && (AUTH_TEST_SITE_SCENARIOS as readonly string[]).includes(value)
  );
}

router.post(
  '/fixtures',
  requireFixtureApiKey,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { userId, scenario, publicBaseUrl } = body;
    if (typeof userId !== 'string' || userId === '') {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    if (!isScenario(scenario)) {
      res
        .status(400)
        .json({ error: `scenario must be one of ${AUTH_TEST_SITE_SCENARIOS.join(', ')}` });
      return;
    }
    if (typeof publicBaseUrl !== 'string' || publicBaseUrl === '') {
      res.status(400).json({ error: 'publicBaseUrl is required' });
      return;
    }
    try {
      res.status(201).json(await createAuthTestSite({ userId, scenario, publicBaseUrl }));
    } catch (error) {
      respondError(res, error, { user_id: userId, scenario });
    }
  })
);

router.get(
  '/fixtures/:siteId/report',
  requireFixtureApiKey,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      res.json(await buildReport(req.params.siteId));
    } catch (error) {
      respondError(res, error, { site_id: req.params.siteId });
    }
  })
);

/** Marks a boundary in the site's event log, e.g. between two agent runs on one site. */
router.post('/fixtures/:siteId/mark', requireFixtureApiKey, (req: Request, res: Response) => {
  const label = ((req.body ?? {}) as Record<string, unknown>).label;
  try {
    markRun(req.params.siteId, typeof label === 'string' ? label : '');
    res.status(201).json({ siteId: req.params.siteId });
  } catch (error) {
    respondError(res, error, { site_id: req.params.siteId });
  }
});

router.delete(
  '/fixtures/:siteId',
  requireFixtureApiKey,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      res.json(await deleteAuthTestSite(req.params.siteId));
    } catch (error) {
      respondError(res, error, { site_id: req.params.siteId });
    }
  })
);

router.use(pagesRouter);

export default router;
