import type { Request, Response, NextFunction } from 'express';
import type jwt from 'jsonwebtoken';
import { createLogger } from './logger';
import {
  impersonatorFromPayload,
  sessionMethodFromPayload,
  verifySupabaseAccessToken,
} from './supabaseJwt';

const log = createLogger('Auth');

/**
 * Auth Middleware
 *
 * Verifies Supabase access tokens — both the backend's own HS256 tokens (minted
 * after phone-OTP verification) and Supabase-issued asymmetric (ES256) tokens.
 * See providers/supabaseJwt.ts for why both must be accepted.
 */

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email?: string;
    phone?: string;
    /**
     * The operator acting on behalf of `id`, taken from the RFC 8693 `act`
     * claim, or undefined for an ordinary login. Impersonated sessions are
     * minted by POST /api/admin-health/impersonate and are otherwise
     * indistinguishable from the target user's own session, so anything whose
     * correctness depends on "is this really the account holder?" must read it.
     */
    impersonatedBy?: string;
    /** First `amr` method of the session (`otp`, `preview_handoff`, ...). */
    authMethod?: string;
  };
  isInternal?: boolean;
}

async function authenticateRequest(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Try API key first (for internal/worker calls)
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const expectedKey = process.env.BACKEND_API_KEY;

    if (apiKey !== undefined && expectedKey !== undefined && apiKey === expectedKey) {
      req.isInternal = true;
      next();
      return;
    }

    // JWT auth (for user calls)
    const authHeader = req.headers.authorization;

    if (authHeader === undefined || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' });
      return;
    }

    const token = authHeader.substring(7);

    let payload: jwt.JwtPayload;
    try {
      payload = await verifySupabaseAccessToken(token);
    } catch (err) {
      log.error('JWT verification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    req.user = {
      id: payload.sub!,
      email: payload.email,
      phone: payload.phone,
      impersonatedBy: impersonatorFromPayload(payload),
      authMethod: sessionMethodFromPayload(payload),
    };
    req.isInternal = false;

    next();
  } catch (error) {
    log.error('Authentication error', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** Express middleware must return void; contain async token verification here. */
export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  void authenticateRequest(req, res, next);
}

/** User-facing reason a machine-data upload was refused. */
export const IMPERSONATED_UPLOAD_MESSAGE =
  'Cannot upload this machine’s data while viewing another account';

/**
 * Refuse machine-harvested data while the caller is impersonating.
 *
 * Every upload endpoint ingests data read off the CALLER'S OWN device — browser
 * cookies and passwords, iMessage/WhatsApp/Telegram history, browser state,
 * passkeys, and Claude/Codex credentials — and stores it against whatever
 * account the session names. While an admin is impersonating, that account is
 * the target user, so an unguarded upload silently writes the operator's
 * personal data and provider credentials into someone else's account. That is
 * cross-account corruption no later fix can un-write.
 *
 * The desktop client also refuses these syncs, but a client-side check is only
 * as good as the build that is installed: the guard shipped in mac-app v1.1.124
 * while v1.1.121 was still running in the field, and kept leaking. Containment
 * therefore belongs at the boundary that actually performs the write.
 */
export function rejectImpersonatedUpload(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  // Trusted server-to-server callers (worker/agent) carry no user session.
  if (req.isInternal === true) {
    next();
    return;
  }

  // FAIL CLOSED. `req.user` is populated by an authentication middleware that
  // reads the `act` claim; if it is absent this guard cannot prove the caller is
  // the account holder, so it must refuse rather than wave the request through.
  // Failing open here is what makes a mis-ordered or mismatched middleware chain
  // silently uncontained — the exact shape of the original defect.
  if (req.user === undefined) {
    log.warn('Refused machine-data upload with no resolved identity', { path: req.path });
    res.status(403).json({ error: IMPERSONATED_UPLOAD_MESSAGE });
    return;
  }

  if (req.user.impersonatedBy !== undefined) {
    log.warn('Refused machine-data upload from an impersonated session', {
      path: req.path,
      targetUserId: req.user.id,
      operatorUserId: req.user.impersonatedBy,
    });
    res.status(403).json({ error: IMPERSONATED_UPLOAD_MESSAGE });
    return;
  }
  next();
}

/**
 * Auth for routes that ingest data harvested from the caller's machine.
 *
 * Use this INSTEAD of `authenticate` on every such route so authentication and
 * impersonation containment cannot drift apart — a route cannot acquire one
 * without the other. `src/tests/structural/machine-upload-containment.test.ts`
 * fails the build if an upload route falls back to bare `authenticate`.
 */
export const authenticateMachineUpload = [authenticate, rejectImpersonatedUpload];
