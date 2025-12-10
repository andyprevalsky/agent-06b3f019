/**
 * Hybrid Auth Middleware
 * 
 * Accepts either:
 * 1. Internal API key (X-API-Key header)
 * 2. JWT token (Authorization: Bearer)
 * 3. x402 payment (X-PAYMENT header)
 * 
 * Sets req.userId for the route handler to use.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { prisma } from '../lib/prisma';

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
 * Supports: Internal API key, JWT, or x402 payment
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
      // For internal calls, userId may come from body or X-User-Id header
      const bodyUserId = (req.body as any)?.user_id;
      const headerUserId = req.headers['x-user-id'] as string;
      req.userId = bodyUserId || headerUserId;
      return next();
    }

    // 2. Try JWT (for logged-in users)
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
          (err, decoded) => {
            if (err) {
              console.error('JWT verification failed:', err.message);
              res.status(401).json({ error: 'Invalid or expired token' });
              resolve();
              return;
            }

            const payload = decoded as jwt.JwtPayload;
            req.userId = payload.sub!;
            req.user = {
              id: payload.sub!,
              email: payload.email,
              phone: payload.phone,
            };
            req.isInternal = false;
            req.isX402 = false;

            next();
            resolve();
          }
        );
      });
    }

    // 3. Try x402 payment (for crypto payments)
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

      return next();
    }

    // 4. No valid auth method found
    res.status(401).json({ error: 'Authentication required. Provide JWT token, API key, or x402 payment.' });
    
  } catch (error) {
    console.error('Hybrid auth error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Export helper functions for reuse
 */
export { getOrCreateWalletUser, addCredits };

