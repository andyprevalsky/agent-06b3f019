import express, { Router, type Request, type Response } from 'express';

import {
  WAIT_FOR_HUMAN_TOOL_NAME,
  resolveHoldRuntimeConfig,
  type HoldRuntimeConfig,
} from './config';
import { holdReconnectTwiml, parkCallOnHold } from './holdService';
import { handleTwilioCallStatus } from './holdStatusService';
import { HANGUP_TWIML, verifyHoldSessionToken } from './holdTelephonyService';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';

const log = createLogger('VapiHoldRoutes');
const router = Router();

type Json = Record<string, unknown>;

function asJson(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

/** Session id from a webhook URL whose HMAC token checks out, else null. */
function authorizedSession(req: Request, config: HoldRuntimeConfig): string | null {
  const session = typeof req.query.session === 'string' ? req.query.session : '';
  const token = typeof req.query.token === 'string' ? req.query.token : undefined;
  return verifyHoldSessionToken(config.tokenSecret, session, token) ? session : null;
}

interface ToolCall {
  id: string;
  name: string;
  heard?: string;
}

function parseArguments(raw: unknown): Json {
  if (typeof raw !== 'string') return asJson(raw);
  try {
    return asJson(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Vapi tool-calls webhook: `message.toolCallList` (current) or `message.toolCalls`. */
function parseToolCalls(message: Json): ToolCall[] {
  const list = Array.isArray(message.toolCallList)
    ? message.toolCallList
    : Array.isArray(message.toolCalls)
      ? message.toolCalls
      : [];
  return list.flatMap((entry: unknown) => {
    const call = asJson(entry);
    const fn = asJson(call.function);
    if (typeof call.id !== 'string' || typeof fn.name !== 'string') return [];
    const heard = parseArguments(fn.arguments).heard;
    return [{ id: call.id, name: fn.name, heard: typeof heard === 'string' ? heard : undefined }];
  });
}

/**
 * wait_for_human tool webhook (called by Vapi mid-conversation).
 * POST /api/vapi/hold/tool?session=&token=
 */
router.post(
  '/tool',
  asyncHandler(async (req: Request, res: Response) => {
    const config = resolveHoldRuntimeConfig();
    if (config === null) {
      res.status(503).json({ error: 'Hold parking is not configured' });
      return;
    }
    const sessionId = authorizedSession(req, config);
    if (sessionId === null) {
      res.status(403).json({ error: 'Invalid hold session token' });
      return;
    }
    const message = asJson(asJson(req.body).message);
    const vapiCallId = asJson(message.call).id;
    const results: Array<{ toolCallId: string; result: string }> = [];
    for (const call of parseToolCalls(message)) {
      const result =
        call.name === WAIT_FOR_HUMAN_TOOL_NAME
          ? await parkCallOnHold(config, sessionId, {
              vapiCallId: typeof vapiCallId === 'string' ? vapiCallId : undefined,
              heard: call.heard,
            })
          : `Unknown tool ${call.name}.`;
      results.push({ toolCallId: call.id, result });
    }
    log.info('wait_for_human tool call', { session_id: sessionId, results: results.length });
    res.json({ results });
  })
);

/**
 * Twilio call status callback.
 * POST /api/vapi/hold/twilio/status?session=&token=  (form: CallStatus, CallSid)
 */
router.post(
  '/twilio/status',
  express.urlencoded({ extended: false }),
  asyncHandler(async (req: Request, res: Response) => {
    const config = resolveHoldRuntimeConfig();
    const sessionId = config === null ? null : authorizedSession(req, config);
    if (sessionId === null) {
      res.status(403).end();
      return;
    }
    const callStatus = asJson(req.body).CallStatus;
    if (typeof callStatus === 'string') await handleTwilioCallStatus(sessionId, callStatus);
    res.status(204).end();
  })
);

/**
 * TwiML fetched by the hold stream's <Redirect> after the stream drops.
 * POST /api/vapi/hold/twilio/twiml?session=&token=
 */
router.post(
  '/twilio/twiml',
  express.urlencoded({ extended: false }),
  asyncHandler(async (req: Request, res: Response) => {
    const config = resolveHoldRuntimeConfig();
    const sessionId = config === null ? null : authorizedSession(req, config);
    res.type('text/xml');
    if (config === null || sessionId === null) {
      res.status(403).send(HANGUP_TWIML);
      return;
    }
    res.send(await holdReconnectTwiml(config, sessionId));
  })
);

export default router;
