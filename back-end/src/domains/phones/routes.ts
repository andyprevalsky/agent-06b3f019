/**
 * /api/phones — phones attached to the user's Macs (iPhone Mirroring).
 *
 *   GET  /                         list the caller's phones (PhoneState[])
 *   GET  /:id                      one phone (cheap state poll for the UI)
 *   POST /register                 Mac app presence heartbeat (upsert)
 *   POST /:id/take-control         user takes (or renews) control
 *   POST /:id/release              user hands control back
 *   POST /:id/agent/acquire        agent acquires/renews (internal key)
 *   POST /:id/agent/heartbeat      agent keeps its lease (internal key)
 *   POST /:id/agent/release        agent is done (internal key)
 *   GET  /:id/stream-demand        Mac long-poll: should it stream frames?
 *   PUT  /:id/frame/upload         Mac uploads one JPEG frame
 *   GET  /:id/frame?after=<seq>    viewer pulls the newest frame (204 if none)
 *
 * Auth: hybrid (user JWT, or the internal API key with X-User-Id/user_id).
 * Mac writes (register, frame upload) apply rejectImpersonatedUpload: an
 * operator's Mac must never attach its phone or screen to the account it is
 * viewing (cemented by structural/machine-upload-containment.test.ts).
 */
import express, { Router, type Response } from 'express';
import { rejectImpersonatedUpload } from '../../providers/auth';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { FRAME_MAX_BYTES, STREAM_DEMAND_MAX_WAIT_MS } from './config';
import * as service from './service';
import * as agentService from './service.agent';
import {
  latestFrame,
  markViewer,
  storeFrame,
  streamDemand,
  waitForStreamDemand,
} from './service.frames';
import {
  agentPhoneLeaseSchema,
  frameQuerySchema,
  phoneIdSchema,
  registerPhoneSchema,
  streamDemandQuerySchema,
} from './types';

const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

const FRAME_CONTENT_TYPES = ['image/jpeg', 'image/png'];
const FRAME_HEADERS =
  'X-Phone-Frame-Seq, X-Phone-Frame-Captured-At, X-Phone-Frame-Width, X-Phone-Frame-Height';

function requireUserId(req: HybridAuthRequest, res: Response): string | null {
  if (typeof req.userId === 'string' && req.userId.length > 0) return req.userId;
  res.status(401).json({ error: 'Unauthorized: user id required' });
  return null;
}

function phoneIdParam(req: HybridAuthRequest, res: Response): string | null {
  const parsed = phoneIdSchema.safeParse(req.params.id);
  if (parsed.success) return parsed.data;
  res.status(404).json({ code: 'PHONE_NOT_FOUND', error: 'Phone not found' });
  return null;
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof service.PhoneControlError) {
    res.status(err.status).json({ code: err.code, error: err.message });
    return;
  }
  throw err;
}

function invalidBody(res: Response, issues: { path: (string | number)[]; message: string }[]) {
  res.status(400).json({
    error: 'Invalid body',
    details: issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  });
}

router.get(
  '/',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) return;
    res.json(await service.listPhones(userId));
  })
);

router.post(
  '/register',
  auth,
  rejectImpersonatedUpload,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) return;
    const parsed = registerPhoneSchema.safeParse(req.body);
    if (!parsed.success) {
      invalidBody(res, parsed.error.issues);
      return;
    }
    res.json(await service.registerPhone(userId, parsed.data));
  })
);

router.get(
  '/:id',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    const phoneId = userId === null ? null : phoneIdParam(req, res);
    if (userId === null || phoneId === null) return;
    try {
      res.json(await service.getPhone(userId, phoneId));
    } catch (err) {
      sendError(res, err);
    }
  })
);

router.post(
  '/:id/take-control',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    const phoneId = userId === null ? null : phoneIdParam(req, res);
    if (userId === null || phoneId === null) return;
    try {
      res.json(await service.takeControl(userId, phoneId));
    } catch (err) {
      sendError(res, err);
    }
  })
);

router.post(
  '/:id/release',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    const phoneId = userId === null ? null : phoneIdParam(req, res);
    if (userId === null || phoneId === null) return;
    try {
      res.json(await service.releaseUserControl(userId, phoneId));
    } catch (err) {
      sendError(res, err);
    }
  })
);

type AgentOperation = 'acquire' | 'heartbeat' | 'release';

function agentRoute(operation: AgentOperation) {
  return asyncHandler<HybridAuthRequest>(async (req, res) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Agent phone control requires the internal API key' });
      return;
    }
    const userId = requireUserId(req, res);
    const phoneId = userId === null ? null : phoneIdParam(req, res);
    if (userId === null || phoneId === null) return;
    const parsed = agentPhoneLeaseSchema.safeParse(req.body);
    if (!parsed.success) {
      invalidBody(res, parsed.error.issues);
      return;
    }
    const { agent_id: agentId, lease_id: leaseId } = parsed.data;
    try {
      if (operation === 'acquire') {
        res.json(await agentService.acquireForAgent(userId, phoneId, agentId));
      } else if (operation === 'heartbeat') {
        res.json(await agentService.heartbeatForAgent(userId, phoneId, agentId, leaseId));
      } else {
        res.json(await agentService.releaseForAgent(userId, phoneId, agentId, leaseId));
      }
    } catch (err) {
      sendError(res, err);
    }
  });
}

router.post('/:id/agent/acquire', auth, agentRoute('acquire'));
router.post('/:id/agent/heartbeat', auth, agentRoute('heartbeat'));
router.post('/:id/agent/release', auth, agentRoute('release'));

router.get(
  '/:id/stream-demand',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    const phoneId = userId === null ? null : phoneIdParam(req, res);
    if (userId === null || phoneId === null) return;
    const query = streamDemandQuerySchema.safeParse(req.query);
    const waitMs = Math.min(
      query.success ? (query.data.waitMs ?? 0) : 0,
      STREAM_DEMAND_MAX_WAIT_MS
    );
    try {
      await service.requireOwnedPhone(userId, phoneId);
    } catch (err) {
      sendError(res, err);
      return;
    }
    // `res` (not `req`) closes when the Mac disconnects mid-wait; a request's
    // own 'close' fires as soon as its (empty) body is consumed.
    const demand = await waitForStreamDemand(phoneId, waitMs, (cancel) => {
      res.on('close', cancel);
    });
    if (!res.headersSent && !res.writableEnded) res.json(demand);
  })
);

router.put(
  '/:id/frame/upload',
  auth,
  rejectImpersonatedUpload,
  express.raw({ type: FRAME_CONTENT_TYPES, limit: FRAME_MAX_BYTES }),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    const phoneId = userId === null ? null : phoneIdParam(req, res);
    if (userId === null || phoneId === null) return;
    const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim();
    const body: unknown = req.body;
    if (!FRAME_CONTENT_TYPES.includes(contentType) || !Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Expected a non-empty image/jpeg or image/png body' });
      return;
    }
    try {
      await service.requireOwnedPhone(userId, phoneId);
    } catch (err) {
      sendError(res, err);
      return;
    }
    const width = Number(req.headers['x-phone-frame-width'] ?? 0);
    const height = Number(req.headers['x-phone-frame-height'] ?? 0);
    const frame = storeFrame(phoneId, {
      bytes: body,
      contentType,
      width: Number.isFinite(width) && width > 0 ? Math.round(width) : 0,
      height: Number.isFinite(height) && height > 0 ? Math.round(height) : 0,
    });
    res.json({ seq: frame.seq, stream: streamDemand(phoneId) });
  })
);

router.get(
  '/:id/frame',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    const phoneId = userId === null ? null : phoneIdParam(req, res);
    if (userId === null || phoneId === null) return;
    try {
      await service.requireOwnedPhone(userId, phoneId);
    } catch (err) {
      sendError(res, err);
      return;
    }
    markViewer(phoneId);
    const query = frameQuerySchema.safeParse(req.query);
    const frame = latestFrame(phoneId, query.success ? query.data.after : undefined);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Expose-Headers', FRAME_HEADERS);
    if (!frame) {
      res.status(204).end();
      return;
    }
    res.setHeader('Content-Type', frame.contentType);
    res.setHeader('X-Phone-Frame-Seq', String(frame.seq));
    res.setHeader('X-Phone-Frame-Captured-At', new Date(frame.capturedAt).toISOString());
    res.setHeader('X-Phone-Frame-Width', String(frame.width));
    res.setHeader('X-Phone-Frame-Height', String(frame.height));
    res.status(200).send(frame.bytes);
  })
);

export default router;
