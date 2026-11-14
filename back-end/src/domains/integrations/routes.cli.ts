/** Conversational CLI setup; agent creation stays at the server composition boundary. */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  createCliIntegration,
  listCliIntegrations,
  CliIntegrationError,
  type LaunchCliSetup,
} from '../../providers/cliIntegrations';

const requestSchema = z
  .object({ request: z.string().trim().min(1).max(2000), request_id: z.string().uuid() })
  .strict();

export function createCliIntegrationRoutes(launch: LaunchCliSetup): Router {
  const router = Router();
  function owner(req: AuthRequest, res: Response): string | null {
    const userId = req.isInternal === true ? req.headers['x-user-id'] : req.user?.id;
    if (typeof userId !== 'string' || !userId) {
      res.status(401).json({ error: 'User not authenticated' });
      return null;
    }
    return userId;
  }
  router.get(
    '/',
    authenticate,
    asyncHandler<AuthRequest>(async (req, res) => {
      const userId = owner(req, res);
      if (userId === null) return;
      res.setHeader('Cache-Control', 'no-store');
      res.json(await listCliIntegrations(userId));
    })
  );
  router.post(
    '/',
    authenticate,
    asyncHandler<AuthRequest>(async (req, res) => {
      const userId = owner(req, res);
      if (userId === null) return;
      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Enter a CLI request and a valid request_id' });
        return;
      }
      try {
        res.status(201).json({
          integration: await createCliIntegration(
            userId,
            parsed.data.request,
            parsed.data.request_id,
            launch
          ),
        });
      } catch (error) {
        if (error instanceof CliIntegrationError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    })
  );
  return router;
}
