import { basename } from 'node:path';
import type { Router, Response, RequestHandler } from 'express';
import { z } from 'zod';
import {
  listCliIntegrations,
  publishCliIntegration,
  runCliIntegration,
} from '../../providers/cliIntegrations';
import {
  acquireCliCredentials,
  heartbeatCliCredentials,
  releaseCliCredentials,
  isCliCredentialPath,
} from '../../providers/cliNativeCredentials';
import { asyncHandler } from '../../utils/asyncHandler';
import { resolveContext } from './service';
import type { AgentToolsCaller } from './types';
import type { HybridAuthRequest } from '../../providers/hybridAuth';

function invalidBody(res: Response, issues: { path: (string | number)[]; message: string }[]) {
  res.status(400).json({
    error: 'Invalid body',
    details: issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  });
}
const cliArgsSchema = z
  .array(
    z
      .string()
      .max(8192)
      .refine((arg) => !arg.includes('\0'))
  )
  .max(128);
const cliPublishSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    command: z
      .string()
      .min(2)
      .max(4096)
      .refine(
        (value) =>
          value.startsWith('/') &&
          !value.includes('\0') &&
          !value.includes('/.rose/') &&
          /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(basename(value)) &&
          ![
            'rose',
            'rose-ui',
            'rose-agents',
            'rose-preview',
            'node',
            'sh',
            'bash',
            'claude',
            'codex',
          ].includes(basename(value))
      ),
    verify: cliArgsSchema.min(1),
    install: z.string().min(1).max(32768),
    install_verify: cliArgsSchema.min(1),
    credential_files: z.array(z.string().max(512).refine(isCliCredentialPath)).max(16),
  })
  .strict();
const cliRunSchema = z.object({ args: cliArgsSchema, request_id: z.string().uuid() }).strict();

export function mountCliToolRoutes<T extends HybridAuthRequest>(
  router: Router,
  agentToolsAuth: RequestHandler,
  callerFor: (req: T, res: Response) => AgentToolsCaller | null,
  sendError: (res: Response, err: unknown) => void
): void {
  router.get(
    '/:agentId/cli',
    agentToolsAuth,
    asyncHandler<T>(async (req, res) => {
      const caller = callerFor(req, res);
      if (caller === null) return;
      try {
        const context = await resolveContext(caller);
        res.json(await listCliIntegrations(context.agent.userId));
      } catch (err) {
        sendError(res, err);
      }
    })
  );

  for (const operation of ['publish', 'run'] as const) {
    router.post(
      `/:agentId/cli/:integrationId/${operation}`,
      agentToolsAuth,
      asyncHandler<T>(async (req, res) => {
        const caller = callerFor(req, res);
        if (caller === null) return;
        if (caller.kind !== 'code_agent') {
          res.status(403).json({ error: 'A code-agent session is required' });
          return;
        }
        try {
          await resolveContext(caller);
          if (operation === 'publish') {
            const parsed = cliPublishSchema.safeParse(req.body);
            if (!parsed.success) return invalidBody(res, parsed.error.issues);
            res.json(
              await publishCliIntegration(caller, String(req.params.integrationId), parsed.data)
            );
          } else {
            const parsed = cliRunSchema.safeParse(req.body);
            if (!parsed.success) return invalidBody(res, parsed.error.issues);
            res.json(
              await runCliIntegration(
                caller,
                String(req.params.integrationId),
                parsed.data.args,
                parsed.data.request_id
              )
            );
          }
        } catch (err) {
          sendError(res, err);
        }
      })
    );
  }
  mountNativeCliRoutes(router, agentToolsAuth, callerFor, sendError);
}

function mountNativeCliRoutes<T extends HybridAuthRequest>(
  router: Router,
  agentToolsAuth: RequestHandler,
  callerFor: (req: T, res: Response) => AgentToolsCaller | null,
  sendError: (res: Response, err: unknown) => void
): void {
  for (const operation of ['acquire', 'heartbeat', 'release'] as const) {
    router.post(
      `/:agentId/cli/:integrationId/native/${operation}`,
      agentToolsAuth,
      asyncHandler<T>(async (req, res) => {
        const caller = callerFor(req, res);
        if (caller === null) return;
        if (caller.kind !== 'code_agent') {
          res.status(403).json({ error: 'A code-agent session is required' });
          return;
        }
        try {
          await resolveContext(caller);
          const token = z.string().uuid();
          const file = z
            .object({
              path: z.string().max(512).refine(isCliCredentialPath),
              data: z.string().max(87384).nullable(),
            })
            .strict();
          const schema =
            operation === 'acquire'
              ? z.object({}).strict()
              : operation === 'heartbeat'
                ? z.object({ lease_token: token }).strict()
                : z.object({ lease_token: token, files: z.array(file).max(16) }).strict();
          const parsed = schema.safeParse(req.body);
          if (!parsed.success) return invalidBody(res, parsed.error.issues);
          const id = String(req.params.integrationId);
          const body = parsed.data as {
            lease_token: string;
            files: Array<{ path: string; data: string | null }>;
          };
          res.setHeader('Cache-Control', 'no-store');
          if (operation === 'acquire') res.json(await acquireCliCredentials(caller, id));
          else if (operation === 'heartbeat')
            res.json(await heartbeatCliCredentials(caller, id, body.lease_token));
          else res.json(await releaseCliCredentials(caller, id, body.lease_token, body.files));
        } catch (error) {
          sendError(res, error);
        }
      })
    );
  }
}
