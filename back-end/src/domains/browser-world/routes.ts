/**
 * Browser world routes (plan row A6) — thin controller layer. Every route is
 * owner-scoped to the authenticated user (JWT, or API key + X-User-Id).
 *
 * GET    /api/browser-world/root[?agent_id=]  home browser (or null), template sites, and
 *                                             default_url: the URL agent_id's tree is on
 * POST   /api/browser-world/root/open         open or reuse the home browser → live view
 *                                             {start_url?, agent_id?}; no start_url →
 *                                             agent_id's default_url
 * POST   /api/browser-world/root/close        close it; its credentials percolate
 * GET    /api/browser-world/sites             template state per (site, account)
 * DELETE /api/browser-world/sites/:site       forget one site (every account)
 * GET    /api/browser-world/agents/:agentId   that agent's browser tasks and their forks
 *
 * Only POST /root/open starts a home browser; the UI calls it when the user
 * opens the Browser app. Nothing here opens one as a side effect.
 *
 * Taking over any tab (Root's or an agent's) uses the existing
 * /api/browser-session/task/:taskId/live-view and /control routes; every view
 * here carries those paths.
 */
import { type Response, Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import { agentIdParamSchema, openRootBrowserSchema, siteParamSchema } from './types';

const log = createLogger('BrowserWorldRoutes');
const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

function ownerOf(req: HybridAuthRequest, res: Response): string | null {
  const userId = req.userId;
  if (userId === undefined || userId === '') {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return userId;
}

router.get(
  '/root',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    const userId = ownerOf(req, res);
    if (userId === null) return;
    const rawAgentId = req.query.agent_id;
    const agentId = rawAgentId === undefined ? undefined : agentIdParamSchema.safeParse(rawAgentId);
    if (agentId !== undefined && !agentId.success) {
      res.status(400).json({ error: 'Invalid agent id' });
      return;
    }
    res.json(await service.getRootBrowser(userId, { agentId: agentId?.data }));
  })
);

router.post(
  '/root/open',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    const userId = ownerOf(req, res);
    if (userId === null) return;
    const parsed = openRootBrowserSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid Root browser request', issues: parsed.error.issues });
      return;
    }
    try {
      const root = await service.openRootBrowser(userId, {
        startUrl: parsed.data.start_url,
        agentId: parsed.data.agent_id,
      });
      res.json({ root });
    } catch (error) {
      log.error('Failed to open Root browser', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to open Root browser' });
    }
  })
);

router.post(
  '/root/close',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    const userId = ownerOf(req, res);
    if (userId === null) return;
    try {
      res.json({ root: null, ...(await service.closeRootBrowser(userId)) });
    } catch (error) {
      if (error instanceof service.RootBrowserNotOpenError) {
        res.status(404).json({ error: error.message });
        return;
      }
      throw error;
    }
  })
);

router.get(
  '/sites',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    const userId = ownerOf(req, res);
    if (userId === null) return;
    res.json({ sites: await service.listRootSites(userId) });
  })
);

router.delete(
  '/sites/:site',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    const userId = ownerOf(req, res);
    if (userId === null) return;
    const site = siteParamSchema.safeParse(req.params.site);
    if (!site.success) {
      res.status(400).json({ error: 'Invalid site' });
      return;
    }
    res.json({ forgotten: await service.forgetRootSite(userId, site.data) });
  })
);

router.get(
  '/agents/:agentId',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    const userId = ownerOf(req, res);
    if (userId === null) return;
    const agentId = agentIdParamSchema.safeParse(req.params.agentId);
    if (!agentId.success) {
      res.status(400).json({ error: 'Invalid agent id' });
      return;
    }
    res.json({
      agent_id: agentId.data,
      tasks: await service.listAgentBrowserWorld(userId, agentId.data),
    });
  })
);

export default router;
