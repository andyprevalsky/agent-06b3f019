import type { Request, Response, NextFunction } from 'express';
import type jwt from 'jsonwebtoken';
import { createLogger } from './logger';
import { verifySupabaseAccessToken } from './supabaseJwt';

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

/**
 * Express 4 expects middleware to return void, so keep the promise contained
 * at this provider boundary. authenticateRequest owns error reporting for the
 * entire async verification path.
 */
export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  void authenticateRequest(req, res, next);
}
