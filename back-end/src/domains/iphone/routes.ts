import type { ImessageAuthLossVerifier } from '../../providers/phoneAuthLoss';
import type { MessageVerifier } from '../../providers/phoneMessageVerifier';
import type { CredentialVerifier } from '../../providers/phoneCredentialVerifier';
import { profileBody, setupBody } from './routes.setup';
import { configureSetup, submitSetup } from './service.setup';
import type { SetupVerifier } from '../../providers/phoneSetupVerifier';
import { Router } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import * as service from './service';
import { IPhoneError, type ActionInput, type LeaseAction } from './types';
import * as operations from './service.operations';
import type { PhoneClientFactory } from './types.operations';
import { interaction } from './service.interactions';
import * as connection from './service.connection';
import { requestAccess, type AccessRequestSmsSender } from './service.accessRequest';
import { errorBody, mountDeviceRoutes } from './routes.device';
import { bodyRecord, text } from './routes.body';

const log = createLogger('IPhone');

function actionInput(action: LeaseAction, body: unknown): ActionInput {
  if (action === 'awaiting-auth')
    return { attentionRequestId: text(bodyRecord(body), 'attentionRequestId') };
  if (action !== 'control') return {};
  const mode = bodyRecord(body).mode;
  if (mode !== 'user' && mode !== 'agent') throw new IPhoneError(400, 'mode must be user or agent');
  return { mode };
}

type Handler = (req: HybridAuthRequest, userId: string) => Promise<unknown>;
function handle(handler: Handler, status = 200) {
  return asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.userId;
      if (userId === undefined || userId === '') throw new IPhoneError(401, 'User scope required');
      const result = await handler(req, userId);
      if (result instanceof Uint8Array) {
        res
          .status(status)
          .set('Cache-Control', 'private, no-store')
          .set('X-Content-Type-Options', 'nosniff')
          .type('png')
          .send(Buffer.from(result));
      } else res.status(status).json(result);
    } catch (error) {
      if (error instanceof IPhoneError) {
        res.status(error.status).json(errorBody(error));
        return;
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        res.status(409).json({ error: 'Device is already bound' });
        return;
      }
      log.error('iPhone operation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'iPhone operation failed' });
    }
  });
}
function executePhoneOperation(
  req: HybridAuthRequest,
  userId: string,
  clientFactory: PhoneClientFactory,
  credentialVerifier?: CredentialVerifier,
  beforeSavedExecute?: () => Promise<void>,
  messageVerifier?: MessageVerifier,
  authLossVerifier?: ImessageAuthLossVerifier
) {
  const body = bodyRecord(req.body);
  const args = body.args === undefined ? {} : bodyRecord(body.args);
  const cursor = body.expectedCursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0)
  )
    throw new IPhoneError(400, 'expectedCursor must be a nonnegative integer');
  if (
    (body.setupAttemptId !== undefined || body.setupRevision !== undefined) &&
    (typeof body.setupAttemptId !== 'string' ||
      typeof body.setupRevision !== 'number' ||
      !Number.isSafeInteger(body.setupRevision) ||
      body.setupRevision < 0)
  )
    throw new IPhoneError(400, 'Invalid setup context');
  if (JSON.stringify(args).length > 16_384) throw new IPhoneError(400, 'Phone input is too large');
  return operations.performPhoneCommand(
    userId,
    req.params.id,
    {
      operationId: text(body, 'operationId'),
      operation: text(body, 'operation'),
      args,
      ...(body.setupAttemptId === undefined
        ? {}
        : {
            setupAttemptId: text(body, 'setupAttemptId'),
            setupRevision: body.setupRevision as number,
          }),
      ...(typeof cursor === 'number' ? { expectedCursor: cursor } : {}),
      ...(body.attentionRequestId !== undefined
        ? { attentionRequestId: text(body, 'attentionRequestId') }
        : {}),
    },
    req.isInternal === true ? 'agent' : 'user',
    clientFactory,
    credentialVerifier,
    beforeSavedExecute,
    messageVerifier,
    authLossVerifier
  );
}

function leaseAction(action: LeaseAction, clientFactory: PhoneClientFactory): Handler {
  return (req, userId) => {
    return service.act(
      userId,
      req.params.id,
      action,
      actionInput(action, req.body),
      clientFactory,
      req.isInternal === true ? 'agent' : 'user'
    );
  };
}

function acquirePhoneLease(
  req: HybridAuthRequest,
  userId: string,
  clientFactory: PhoneClientFactory
) {
  if (req.isInternal !== true) throw new IPhoneError(403, 'Use the browser-task interaction route');
  const body = bodyRecord(req.body);
  return service.acquire(
    userId,
    {
      agentId: text(body, 'agentId'),
      requestKey: text(body, 'requestKey'),
      ...(body.browserTaskId !== undefined ? { browserTaskId: text(body, 'browserTaskId') } : {}),
    },
    clientFactory
  );
}

function ensurePhoneInteraction(
  req: HybridAuthRequest,
  userId: string,
  clientFactory: PhoneClientFactory
) {
  return interaction(
    userId,
    req.params.taskId,
    text(bodyRecord(req.body), 'requestKey'),
    clientFactory
  );
}
interface IPhoneRouterOptions {
  phoneClient?: PhoneClientFactory;
  setupVerifier?: SetupVerifier;
  credentialVerifier?: CredentialVerifier;
  beforeSavedExecute?: () => Promise<void>;
  messageVerifier?: MessageVerifier;
  setupAgentLauncher: connection.SetupAgentLauncher;
  accessRequestSms?: AccessRequestSmsSender;
  authLossVerifier?: ImessageAuthLossVerifier;
}
function phoneOperationHandler(
  clientFactory: PhoneClientFactory,
  options: IPhoneRouterOptions
): Handler {
  return (req, userId) =>
    executePhoneOperation(
      req,
      userId,
      clientFactory,
      options.credentialVerifier,
      options.beforeSavedExecute,
      options.messageVerifier,
      options.authLossVerifier
    );
}
function mountConnectionRoutes(router: ReturnType<typeof Router>, options: IPhoneRouterOptions) {
  router.post(
    '/request-access',
    handle((req, userId) => {
      if (req.isInternal === true) throw new IPhoneError(403, 'User session required');
      if (Object.keys(bodyRecord(req.body)).length !== 0)
        throw new IPhoneError(400, 'Access requests use the authenticated account');
      return requestAccess(userId, options.accessRequestSms);
    })
  );
  router.get(
    '/availability/:taskId',
    handle((req, userId) => connection.availability(userId, req.params.taskId))
  );
  router.get(
    '/connection',
    handle((_req, userId) => connection.connection(userId))
  );
  router.post(
    '/connect',
    handle((req, userId) => {
      const body = bodyRecord(req.body);
      if (
        Object.keys(body).sort().join(',') !== 'expectedRevision,requestKey' ||
        typeof body.expectedRevision !== 'number' ||
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 0
      )
        throw new IPhoneError(400, 'Invalid iPhone connection request');
      return connection.connect(
        userId,
        body.expectedRevision,
        text(body, 'requestKey'),
        options.setupAgentLauncher
      );
    })
  );
}

export function createIPhoneRouter(options: IPhoneRouterOptions) {
  const router = Router();
  const clientFactory = options.phoneClient ?? operations.defaultPhoneClient;
  router.use(asyncHandler(hybridAuth));
  router.put(
    '/device/setup-profile',
    handle((req, userId) => {
      if (req.isInternal !== true) throw new IPhoneError(403, 'Internal API key required');
      const body = profileBody(req.body);
      return configureSetup(
        userId,
        body.revision,
        body.identity,
        body.googleIdentity,
        body.allowGooglePasscodeException
      );
    })
  );
  router.post(
    '/interactions/:taskId/setup',
    handle((req, userId) => {
      if (req.isInternal !== true) throw new IPhoneError(403, 'Internal API key required');
      return submitSetup(
        userId,
        req.params.taskId,
        setupBody(req.body),
        options.setupVerifier,
        clientFactory
      );
    })
  );
  mountConnectionRoutes(router, options);
  router.get(
    '/capability',
    handle((_req, userId) => service.capability(userId))
  );
  mountDeviceRoutes(router, handle, clientFactory);
  router.put(
    '/device',
    handle(async (req, userId) => {
      if (req.isInternal !== true) throw new IPhoneError(403, 'Internal API key required');
      return service.bind(userId, text(bodyRecord(req.body), 'providerDeviceId'));
    })
  );
  router.get(
    '/interactions/:taskId',
    handle((req, userId) => interaction(userId, req.params.taskId, undefined, clientFactory))
  );
  router.post(
    '/interactions/:taskId',
    handle((req, userId) => ensurePhoneInteraction(req, userId, clientFactory))
  );
  router.post(
    '/leases',
    handle((req, userId) => {
      return acquirePhoneLease(req, userId, clientFactory);
    }, 201)
  );
  router.get(
    '/leases/:id',
    handle((req, userId) => service.act(userId, req.params.id, 'read', {}, clientFactory))
  );
  for (const action of ['heartbeat', 'release', 'awaiting-auth', 'control'] as const) {
    router.post(`/leases/:id/${action}`, handle(leaseAction(action, clientFactory)));
  }
  router.post('/leases/:id/operations', handle(phoneOperationHandler(clientFactory, options)));
  router.get(
    '/leases/:id/operations/:operationId',
    handle((req, userId) =>
      operations.phoneOperationStatus(userId, req.params.id, req.params.operationId)
    )
  );
  router.get(
    '/leases/:id/frame',
    handle((req, userId) =>
      operations.phoneFrame(userId, req.params.id, clientFactory, req.isInternal !== true)
    )
  );
  return router;
}
