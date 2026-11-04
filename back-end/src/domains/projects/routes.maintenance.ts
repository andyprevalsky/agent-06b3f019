/**
 * Template-sync (maintenance) routes, mounted by `routes.ts` behind the same
 * projects auth and request helpers:
 *
 *   GET    /api/projects/:id/maintenance              template snapshot, schedule, recent runs
 *   POST   /api/projects/:id/maintenance/runs         Run now {mode: sync} / Snapshot now {mode: snapshot}
 *   GET    /api/projects/:id/maintenance/runs/:runId  one run with its (redacted) log
 */
import type { RequestHandler, Response, Router } from 'express';
import type { z } from 'zod';
import * as maintenance from './maintenanceService';
import { maintenanceRunSchema } from './types';

type Handler<Req> = (req: Req, res: Response, userId: string) => Promise<void>;

export interface MaintenanceRouteHelpers<Req> {
  handle: (fn: Handler<Req>) => RequestHandler;
  idParam: (req: Req, res: Response, name?: string) => string | null;
  parse: <S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response) => z.infer<S> | null;
}

export function registerMaintenanceRoutes<Req extends { body?: unknown }>(
  router: Router,
  { handle, idParam, parse }: MaintenanceRouteHelpers<Req>
): void {
  router.get(
    '/:id/maintenance',
    handle(async (req, res, userId) => {
      const id = idParam(req, res);
      if (id !== null) res.json(await maintenance.getMaintenance(userId, id));
    })
  );

  router.post(
    '/:id/maintenance/runs',
    handle(async (req, res, userId) => {
      const id = idParam(req, res);
      const body = id !== null ? parse(maintenanceRunSchema, req.body ?? {}, res) : null;
      if (id === null || body === null) return;
      const { run } = await maintenance.triggerRun(userId, id, body.mode ?? 'sync');
      res.status(202).json(run);
    })
  );

  router.get(
    '/:id/maintenance/runs/:runId',
    handle(async (req, res, userId) => {
      const id = idParam(req, res);
      const runId = id !== null ? idParam(req, res, 'runId') : null;
      if (id !== null && runId !== null) res.json(await maintenance.getRun(userId, id, runId));
    })
  );
}
