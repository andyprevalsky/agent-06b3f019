/**
 * Integrations domain routes — main router + CRUD + mounts sub-routers.
 * Sub-routers: routes.upload.ts, routes.browser.ts, routes.email.ts, routes.claude.ts,
 * routes.compute.ts, routes.plaid.ts
 */

import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';

import uploadRoutes from './routes.upload';
import browserRoutes from './routes.browser';
import passkeyRoutes from './routes.passkeys';
import emailRoutes from './routes.email';
import claudeRoutes from './routes.claude';
import computeRoutes from './routes.compute';
import plaidRoutes from './routes.plaid';
import documentRoutes from './routes.documents';
import lanternRoutes from './routes.lantern';
import linkedinRoutes from './routes.linkedin';

const router = Router();

// Mount sub-routers
router.use(uploadRoutes);
router.use(browserRoutes);
router.use(passkeyRoutes);
router.use(emailRoutes);
router.use(claudeRoutes);
router.use(computeRoutes);
router.use(plaidRoutes);
router.use(documentRoutes);
router.use(lanternRoutes);
router.use(linkedinRoutes);

// ---------------------------------------------------------------------------
// CRUD routes
// ---------------------------------------------------------------------------

/** GET /api/integrations */
router.get(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.isInternal === true ? (req.headers['x-user-id'] as string) : req.user?.id;

    if (userId === undefined || userId === null || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const result = await service.getIntegrations(userId);
    return res.json(result);
  })
);

/** POST /api/integrations */
router.post(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { name, type } = req.body;

    if (
      name === undefined ||
      name === null ||
      name === '' ||
      type === undefined ||
      type === null ||
      type === ''
    ) {
      return res.status(400).json({ error: 'name and type are required' });
    }

    const { config } = req.body;

    try {
      const integration = await service.createIntegration(userId, name, type, config);
      return res.json({ integration });
    } catch (error: unknown) {
      if (error instanceof service.LanternCredentialError)
        return res.status(error.status).json({ error: error.code });
      if (error instanceof service.InvalidIntegrationTypeError) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** PATCH /api/integrations/:name */
router.patch(
  '/:name',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { name } = req.params;
    const { status, isActive, config } = req.body;

    try {
      const updated = await service.updateIntegration(userId, name, {
        status,
        isActive,
        config,
      });
      return res.json({ integration: updated });
    } catch (error: unknown) {
      if (error instanceof service.LanternCredentialError)
        return res.status(error.status).json({ error: error.code });
      if (error instanceof service.IntegrationNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** DELETE /api/integrations/:name */
router.delete(
  '/:name',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { name } = req.params;

    try {
      await service.deleteIntegration(userId, name);
      return res.json({ message: 'Integration deleted successfully' });
    } catch (error: unknown) {
      if (error instanceof service.LanternCredentialError)
        return res.status(error.status).json({ error: error.code });
      if (error instanceof service.IntegrationNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      throw error;
    }
  })
);

export default router;
