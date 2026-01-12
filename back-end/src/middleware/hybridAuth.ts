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

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { prisma } from '../lib/prisma';
import { createInitialCredit } from '../lib/credits';

// Lazy initialization of JWKS client
let client: jwksClient.JwksClient | null = null;

function getJwksClient() {
  if (!client) {
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!supabaseUrl) {
      throw new Error('Missing SUPABASE_URL environment variable');
    }

    client = jwksClient({
      jwksUri: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 600000, // 10 minutes
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
  }
  return client;
}

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

// Function to get the signing key from JWKS
function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  const jwksClient = getJwksClient();
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

/**
 * Helper: Get or create user by wallet address
 */
async function getOrCreateWalletUser(walletAddress: string) {
  const userId = walletAddress.toLowerCase(); // Normalize

  let user = await prisma.user.findUnique({
    where: { userId }
  });

  if (!user) {
    user = await prisma.user.create({
      data: { userId }
    });
    console.log(`✅ Created x402 user for wallet: ${userId}`);
  }

  return user;
}

/**
 * Helper: Add credits for a user
 */
async function addCredits(userId: string, amountDollars: number) {
  const amountCents = Math.round(amountDollars * 100);

  const credit = await prisma.credit.create({
    data: {
      userId,
      amountCents,
      expirationDate: null, // Never expires
    }
  });

  console.log(`💰 Added $${amountDollars} credit for user ${userId}`);
  return credit;
}

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
    // 1. Try internal API key first (for worker calls)
    const apiKey = req.headers['x-api-key'] as string;
    const expectedKey = process.env.BACKEND_API_KEY;

    if (apiKey && expectedKey && apiKey === expectedKey) {
      req.isInternal = true;
      req.isX402 = false;
      req.isRoseApiKey = false;
      // For internal calls, userId may come from body or X-User-Id header
      const bodyUserId = (req.body as any)?.user_id;
      const headerUserId = req.headers['x-user-id'] as string;
      req.userId = bodyUserId || headerUserId;
      return next();
    }

    // 2. Try Rose API key (for external API access)
    if (apiKey) {
      const roseApiKey = await prisma.roseApiKey.findUnique({
        where: { apiKey },
      });

      if (roseApiKey) {
        // Verify user has active subscription
        const subscription = await prisma.subscription.findUnique({
          where: { userId: roseApiKey.userId },
        });

        if (!subscription) {
          res.status(403).json({
            error: 'Active subscription required',
            message: 'API access requires an active subscription. Visit roselabs.ai to subscribe.',
          });
          return;
        }

        req.userId = roseApiKey.userId;
        req.isInternal = false;
        req.isX402 = false;
        req.isRoseApiKey = true;
        req.isAnonymous = false;
        return next();
      }

      // Invalid API key - don't fall through to JWT, return error
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    // 3. Try JWT (for web/mobile app users)
    // Anonymous users created via Supabase signInAnonymously() have real JWTs
    // with is_anonymous=true in the payload
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const supabaseUrl = process.env.SUPABASE_URL;

      if (!supabaseUrl) {
        res.status(500).json({ error: 'Server configuration error' });
        return;
      }

      // Verify JWT asynchronously
      return new Promise<void>((resolve) => {
        jwt.verify(
          token,
          getKey,
          {
            issuer: `${supabaseUrl}/auth/v1`,
            algorithms: ['ES256', 'HS256', 'RS256'],
          },
          async (err, decoded) => {
            if (err) {
              console.error('JWT verification failed:', err.message);
              res.status(401).json({ error: 'Invalid or expired token' });
              resolve();
              return;
            }

            const payload = decoded as jwt.JwtPayload;
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

            // Ensure user record exists in our database
            // This is especially important for anonymous users created by Supabase
            // Use upsert to handle race conditions cleanly (no error logs)
            const result = await prisma.user.upsert({
              where: { userId },
              create: {
                userId,
                isAnonymous,
                phone: payload.phone || null,
              },
              update: {
                // Update phone if provided and user exists
                ...(payload.phone ? { phone: payload.phone } : {}),
              },
            });

            // Check if this was a new user (createdAt equals updatedAt within 1 second)
            const isNewUser = Math.abs(result.createdAt.getTime() - result.updatedAt.getTime()) < 1000;
            if (isNewUser) {
              console.log(`✅ Created user record for ${userId} (anonymous: ${isAnonymous})`);
              // Give initial credit to new users (both anonymous and regular)
              await createInitialCredit(userId);
            }

            next();
            resolve();
          }
        );
      });
    }

    // 4. Try x402 payment (for crypto payments)
    const payment = (req as any).payment;
    if (payment) {
      const paymentAmount = parseFloat(payment.amount || '0');
      const payerWallet = payment.payer as string;

      if (!payerWallet) {
        res.status(400).json({ error: 'Payer wallet address required' });
        return;
      }

      if (paymentAmount < 0.05) {
        res.status(400).json({ error: 'Minimum payment is $0.05' });
        return;
      }

      // Get or create user for this wallet
      const user = await getOrCreateWalletUser(payerWallet);

      // Add credits from payment
      await addCredits(user.userId, paymentAmount);

      req.userId = user.userId;
      req.isInternal = false;
      req.isX402 = true;
      req.isRoseApiKey = false;
      req.isAnonymous = false;

      return next();
    }

    // 5. No valid auth method found
    res.status(401).json({
      error: 'Authentication required. Provide JWT token, API key, or x402 payment.',
    });

  } catch (error) {
    console.error('Hybrid auth error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Export helper functions for reuse
 */
export { getOrCreateWalletUser, addCredits };
