/** POST /api/integrations/requests {request, request_id}: ask Rose to add an integration. */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  IntegrationRequestError,
  requestIntegration,
  type IntegrationRequestSmsSender,
} from './service.integrationRequest';

const bodySchema = z
  .object({ request: z.string().trim().min(1).max(200), request_id: z.string().uuid() })
  .strict();

export function createIntegrationRequestRoutes(
  options: { sms?: IntegrationRequestSmsSender } = {}
): Router {
  const router = Router();
  router.post(
    '/',
    authenticate,
    asyncHandler<AuthRequest>(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const userId = req.isInternal === true ? req.headers['x-user-id'] : req.user?.id;
      if (typeof userId !== 'string' || userId === '') {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Enter the integration you want (up to 200 characters)' });
        return;
      }
      try {
        res.json(
          await requestIntegration(userId, parsed.data.request, parsed.data.request_id, options.sms)
        );
      } catch (error) {
        if (error instanceof IntegrationRequestError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    })
  );
  return router;
}
