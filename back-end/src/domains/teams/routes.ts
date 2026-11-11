import { Router, type Response } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import { normalizedEmail, objectBody, teamName, TeamError, uuid } from './types';

const router = Router();
router.use((req, res, next) => {
  void hybridAuth(req, res, next);
});
function handle(fn: (req: HybridAuthRequest, res: Response, userId: string) => Promise<void>) {
  return asyncHandler<HybridAuthRequest>(async (req, res) => {
    if (req.userId === undefined || req.userId === '') {
      res.status(400).json({ error: 'X-User-Id is required' });
      return;
    }
    try {
      await service.requireUser(req.userId);
      await fn(req, res, req.userId);
    } catch (error) {
      if (error instanceof TeamError) {
        res.status(error.status).json({
          error: error.message,
          ...(error.code !== undefined ? { code: error.code } : {}),
        });
        return;
      }
      throw error;
    }
  });
}
router.get(
  '/',
  handle(async (_req, res, userId) => {
    res.json(await service.listTeams(userId));
  })
);
router.post(
  '/',
  handle(async (req, res, userId) => {
    const body = objectBody(req.body, ['name']);
    res.status(201).json(await service.createTeam(userId, teamName(body.name)));
  })
);
router.get(
  '/contacts',
  handle(async (req, res, userId) => {
    res.json(await service.contacts(userId, typeof req.query.q === 'string' ? req.query.q : ''));
  })
);
router.get(
  '/shared-projects',
  handle(async (_req, res, userId) => {
    res.json(await service.listSharedProjects(userId));
  })
);
router.get(
  '/shareable-integrations',
  handle(async (_req, res, userId) => {
    res.json(await service.listShareableIntegrations(userId));
  })
);
router.get(
  '/:id',
  handle(async (req, res, userId) => {
    res.json(await service.getTeam(userId, uuid(req.params.id)));
  })
);
router.patch(
  '/:id',
  handle(async (req, res, userId) => {
    const body = objectBody(req.body, ['name']);
    res.json(await service.renameTeam(userId, uuid(req.params.id), teamName(body.name)));
  })
);
router.post(
  '/:id/invites',
  handle(async (req, res, userId) => {
    const body = objectBody(req.body, ['email', 'retry']);
    if (body.retry !== undefined && typeof body.retry !== 'boolean')
      throw new TeamError(400, 'retry must be a boolean');
    res
      .status(201)
      .json(
        await service.inviteMember(
          userId,
          uuid(req.params.id),
          normalizedEmail(body.email),
          undefined,
          body.retry === true
        )
      );
  })
);
router.post(
  '/:id/invitation',
  handle(async (req, res, userId) => {
    const body = objectBody(req.body ?? {}, ['token']);
    if (typeof body.token !== 'string' || body.token.length > 256 || body.token.length === 0)
      throw new TeamError(400, 'Invitation token is required');
    res.json(await service.previewInvitation(userId, uuid(req.params.id), body.token));
  })
);
router.post(
  '/:id/accept',
  handle(async (req, res, userId) => {
    const body = objectBody(req.body ?? {}, ['token']);
    if (body.token !== undefined && (typeof body.token !== 'string' || body.token.length > 256))
      throw new TeamError(400, 'Invalid invitation token');
    res.json(
      await service.acceptInvite(
        userId,
        uuid(req.params.id),
        body.token as string | undefined,
        req.isInternal === true
      )
    );
  })
);
router.delete(
  '/:id/members/:memberId',
  handle(async (req, res, userId) => {
    await service.removeMember(userId, uuid(req.params.id), uuid(req.params.memberId));
    res.status(204).end();
  })
);
router.put(
  '/:id/integrations/:integrationId',
  handle(async (req, res, userId) => {
    const body = objectBody(req.body ?? {}, ['accountId']);
    if (body.accountId !== undefined && typeof body.accountId !== 'string')
      throw new TeamError(400, 'Invalid accountId');
    res.json(
      await service.shareIntegration(
        userId,
        uuid(req.params.id),
        uuid(req.params.integrationId),
        body.accountId as string | undefined
      )
    );
  })
);
router.delete(
  '/:id/integrations/:integrationId',
  handle(async (req, res, userId) => {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
    await service.unshareIntegration(
      userId,
      uuid(req.params.id),
      uuid(req.params.integrationId),
      accountId
    );
    res.status(204).end();
  })
);
router.put(
  '/:id/projects/:projectId',
  handle(async (req, res, userId) => {
    objectBody(req.body ?? {}, []);
    res.json(await service.shareProject(userId, uuid(req.params.id), uuid(req.params.projectId)));
  })
);
router.delete(
  '/:id/projects/:projectId',
  handle(async (req, res, userId) => {
    await service.unshareProject(userId, uuid(req.params.id), uuid(req.params.projectId));
    res.status(204).end();
  })
);
export default router;
