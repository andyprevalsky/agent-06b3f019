/**
 * Hybrid Auth Middleware
 *
 * Accepts either:
 * 1. Internal API key (X-API-Key header)
 * 2. JWT token (Authorization: Bearer) - includes anonymous users via Supabase signInAnonymously
 * 3. x402 payment (X-PAYMENT header)
 *
 * Sets req.userId for the route handler to use.
 * For anonymous users (Supabase native), the JWT will have is_anonymous=true.
 */

import type { Request, Response, NextFunction } from 'express';
import type jwt from 'jsonwebtoken';
import { prisma } from './database';
import { createInitialCredit } from './credits';
import { createLogger } from './logger';
import { verifySupabaseAccessToken } from './supabaseJwt';

const log = createLogger('HybridAuth');

export interface HybridAuthRequest extends Request {
  userId?: string;
  isInternal?: boolean;
  isX402?: boolean;
  isAnonymous?: boolean;
  isRoseApiKey?: boolean;
  user?: {
    id: string;
    email?: string;
    phone?: string;
  };
}

interface X402Payment {
  amount?: string;
  payer?: string;
}

async function getOrCreateWalletUser(walletAddress: string) {
  const userId = walletAddress.toLowerCase();

  let user = await prisma.user.findUnique({
    where: { userId },
  });

  if (user === null) {
    user = await prisma.user.create({
      data: { userId },
    });
    log.info('Created x402 user for wallet', { userId });
  }

  return user;
}

async function addCredits(userId: string, amountDollars: number) {
  const amountCents = Math.round(amountDollars * 100);

  const credit = await prisma.credit.create({
    data: {
      userId,
      amountCents,
      expirationDate: null,
    },
  });

  log.info('Added credit', { userId, amountDollars });
  return credit;
}

function handleInternalApiKey(
  req: HybridAuthRequest,
  apiKey: string | undefined,
  expectedKey: string | undefined
): boolean {
  if (apiKey !== undefined && expectedKey !== undefined && apiKey === expectedKey) {
    req.isInternal = true;
    req.isX402 = false;
    req.isRoseApiKey = false;
    const body = req.body as Record<string, unknown>;
    const bodyUserId = typeof body?.user_id === 'string' ? body.user_id : undefined;
    const headerUserId = req.headers['x-user-id'] as string | undefined;
    req.userId = bodyUserId ?? headerUserId;
    return true;
  }
  return false;
}

async function handleRoseApiKey(
  req: HybridAuthRequest,
  res: Response,
  apiKey: string
): Promise<'next' | 'done'> {
  const roseApiKey = await prisma.roseApiKey.findUnique({
    where: { apiKey },
  });

  if (roseApiKey === null) {
    res.status(401).json({ error: 'Invalid API key' });
    return 'done';
  }

  const subscription = await prisma.subscription.findUnique({
    where: { userId: roseApiKey.userId },
  });

  if (subscription === null) {
    res.status(403).json({
      error: 'Active subscription required',
      message: 'API access requires an active subscription. Visit roselabs.ai to subscribe.',
    });
    return 'done';
  }

  req.userId = roseApiKey.userId;
  req.isInternal = false;
  req.isX402 = false;
  req.isRoseApiKey = true;
  req.isAnonymous = false;
  return 'next';
}

async function handleJwtAuth(
  req: HybridAuthRequest,
  res: Response,
  next: NextFunction,
  authHeader: string
): Promise<void> {
  const token = authHeader.substring(7);
  const supabaseUrl = process.env.SUPABASE_URL;

  /* c8 ignore next 4 -- config validation: SUPABASE_URL always set in test environment */
  if (supabaseUrl === undefined || supabaseUrl === '') {
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  let payload: jwt.JwtPayload;
  try {
    payload = await verifySupabaseAccessToken(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('JWT verification failed', { error: message });
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const userId = payload.sub!;
  const isAnonymous = payload.is_anonymous === true;

  req.userId = userId;
  req.user = {
    id: userId,
    email: payload.email,
    phone: payload.phone,
  };
  req.isInternal = false;
  req.isX402 = false;
  req.isRoseApiKey = false;
  req.isAnonymous = isAnonymous;

  const result = await prisma.user.upsert({
    where: { userId },
    create: {
      userId,
      isAnonymous,
      phone: typeof payload.phone === 'string' ? payload.phone : null,
    },
    update: {
      ...(typeof payload.phone === 'string' ? { phone: payload.phone } : {}),
    },
  });

  const isNewUser = Math.abs(result.createdAt.getTime() - result.updatedAt.getTime()) < 1000;
  if (isNewUser) {
    log.info('Created user record', { userId, isAnonymous });
    await createInitialCredit(userId);
  }

  next();
}

/* c8 ignore start -- x402 payment requires real blockchain transactions via x402 middleware; unreachable in blackbox tests */
async function handleX402Payment(
  req: HybridAuthRequest,
  res: Response,
  next: NextFunction,
  payment: X402Payment
): Promise<void> {
  const paymentAmount = parseFloat(payment.amount ?? '0');
  const payerWallet = payment.payer;

  if (payerWallet === undefined || payerWallet === '') {
    res.status(400).json({ error: 'Payer wallet address required' });
    return;
  }

  if (paymentAmount < 0.05) {
    res.status(400).json({ error: 'Minimum payment is $0.05' });
    return;
  }

  const user = await getOrCreateWalletUser(payerWallet);
  await addCredits(user.userId, paymentAmount);

  req.userId = user.userId;
  req.isInternal = false;
  req.isX402 = true;
  req.isRoseApiKey = false;
  req.isAnonymous = false;

  next();
}
/* c8 ignore stop */

/**
 * Hybrid authentication middleware
 * Supports: Internal API key, JWT (including anonymous users), or x402 payment
 */
export async function hybridAuth(
  req: HybridAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const expectedKey = process.env.BACKEND_API_KEY;

    if (handleInternalApiKey(req, apiKey, expectedKey)) {
      return next();
    }

    if (apiKey !== undefined && apiKey !== '') {
      const result = await handleRoseApiKey(req, res, apiKey);
      if (result === 'next') return next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return await handleJwtAuth(req, res, next, authHeader);
    }

    /* c8 ignore next 4 -- x402 payment branch unreachable without blockchain middleware */
    const payment = (req as HybridAuthRequest & { payment?: X402Payment }).payment;
    if (payment !== undefined) {
      return await handleX402Payment(req, res, next, payment);
    }

    res.status(401).json({
      error: 'Authentication required. Provide JWT token, API key, or x402 payment.',
    });
  } catch (error) {
    /* c8 ignore next 5 -- generic catch block for unexpected exceptions in auth middleware */
    log.error('Hybrid auth error', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

export { getOrCreateWalletUser, addCredits };
