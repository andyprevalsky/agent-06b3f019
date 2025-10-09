import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

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

export interface AuthRequest extends Request {
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

export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' });
      return;
    }

    const token = authHeader.substring(7);

    // Verify JWT token using JWKS
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      res.status(500).json({ error: 'Server configuration error' });
      return;
    }
    
    jwt.verify(
      token,
      getKey,
      {
        issuer: `${supabaseUrl}/auth/v1`,
        algorithms: ['ES256', 'HS256', 'RS256'], // Support common algorithms
      },
      (err, decoded) => {
        if (err) {
          console.error('JWT verification failed:', err.message);
          res.status(401).json({ error: 'Invalid or expired token' });
          return;
        }

        const payload = decoded as jwt.JwtPayload;

        // Extract user info from token
        req.user = {
          id: payload.sub!,
          email: payload.email,
          phone: payload.phone,
        };

        next();
      }
    );
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

