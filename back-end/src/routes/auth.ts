/**
 * Auth Routes
 *
 * Handles OTP verification with user initialization.
 * OTP is sent/verified via Twilio Verify, then Supabase user is created/found
 * and a JWT session is generated.
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma';
import { createSignupBonusCredit, createInitialCredit } from '../lib/credits';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendMms } from '../lib/smsQueue';
import { SMS_TEMPLATES, getPersonalizedVcardUrl } from '../lib/smsTemplates';

// Twilio Verify response types
interface TwilioVerifyResponse {
  sid?: string;
  status?: string;
  to?: string;
  channel?: string;
  valid?: boolean;
  // Error fields
  code?: number;
  message?: string;
  more_info?: string;
}

// Supabase Admin API response types
interface SupabaseAdminUserResponse {
  id: string;
  phone?: string;
  email?: string;
  phone_confirmed_at?: string;
  created_at?: string;
}

interface SupabaseAdminUsersListResponse {
  users: SupabaseAdminUserResponse[];
}

// Environment config
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

/**
 * Send OTP via Twilio Verify
 */
async function sendTwilioVerifyOTP(phone: string): Promise<{ success: boolean; error?: string }> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
    console.error('[Auth] Missing Twilio Verify configuration');
    return { success: false, error: 'Server configuration error' };
  }

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/Verifications`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: phone,
        Channel: 'sms',
      }),
    });

    const data = await response.json() as TwilioVerifyResponse;

    if (!response.ok) {
      console.error('[Auth] Twilio Verify send error:', {
        status: response.status,
        code: data.code,
        message: data.message,
        phone: phone.slice(0, -4) + '****',
      });
      return { success: false, error: data.message || 'Failed to send OTP' };
    }

    console.log('[Auth] Twilio Verify OTP sent:', {
      sid: data.sid,
      status: data.status,
      phone: phone.slice(0, -4) + '****',
    });

    return { success: true };
  } catch (error) {
    console.error('[Auth] Twilio Verify send exception:', error);
    return { success: false, error: 'Failed to send OTP' };
  }
}

/**
 * Check OTP via Twilio Verify
 */
async function checkTwilioVerifyOTP(phone: string, code: string): Promise<{ approved: boolean; error?: string }> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
    console.error('[Auth] Missing Twilio Verify configuration');
    return { approved: false, error: 'Server configuration error' };
  }

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: phone,
        Code: code,
      }),
    });

    const data = await response.json() as TwilioVerifyResponse;

    if (!response.ok) {
      console.error('[Auth] Twilio Verify check error:', {
        status: response.status,
        code: data.code,
        message: data.message,
        phone: phone.slice(0, -4) + '****',
      });

      // User-friendly error messages
      let errorMessage = 'Invalid code';
      if (response.status === 404 || data.code === 20404) {
        errorMessage = 'Code expired. Please request a new one.';
      } else if (data.code === 60202) {
        errorMessage = 'Too many attempts. Please request a new code.';
      }

      return { approved: false, error: errorMessage };
    }

    const approved = data.status === 'approved';
    console.log('[Auth] Twilio Verify check result:', {
      status: data.status,
      valid: data.valid,
      approved,
      phone: phone.slice(0, -4) + '****',
    });

    return { approved, error: approved ? undefined : 'Invalid OTP' };
  } catch (error) {
    console.error('[Auth] Twilio Verify check exception:', error);
    return { approved: false, error: 'Failed to verify OTP' };
  }
}

/**
 * Find or create Supabase user by phone.
 * First checks our own DB (fast, reliable), then falls back to Supabase Admin API for new users.
 */
async function findOrCreateSupabaseUser(phone: string): Promise<{ userId: string; isNew: boolean } | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[Auth] Missing Supabase configuration');
    return null;
  }

  try {
    // Step 1: Check our own database first (handles existing users reliably)
    // Normalize phone formats: try with and without leading +
    const phoneWithPlus = phone.startsWith('+') ? phone : `+${phone}`;
    const phoneWithoutPlus = phone.startsWith('+') ? phone.slice(1) : phone;

    const existingDbUser = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: phoneWithPlus },
          { phone: phoneWithoutPlus },
        ],
      },
      select: { userId: true },
    });

    if (existingDbUser) {
      console.log('[Auth] Found existing user in our DB:', {
        userId: existingDbUser.userId,
        phone: phone.slice(0, -4) + '****',
      });
      return { userId: existingDbUser.userId, isNew: false };
    }

    // Step 2: Not in our DB - create new user in Supabase
    console.log('[Auth] User not in our DB, creating in Supabase...');
    const createUrl = `${SUPABASE_URL}/auth/v1/admin/users`;
    const createResponse = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phone,
        phone_confirm: true,
      }),
    });

    const createData = await createResponse.json();

    if (createResponse.ok) {
      const newUser = createData as SupabaseAdminUserResponse;
      console.log('[Auth] Created new Supabase user:', { userId: newUser.id, phone: phone.slice(0, -4) + '****' });
      return { userId: newUser.id, isNew: true };
    }

    // Handle phone_exists error (user in Supabase but not our DB - edge case)
    const errorData = createData as { error_code?: string; msg?: string };
    console.error('[Auth] Supabase create failed:', {
      status: createResponse.status,
      error_code: errorData.error_code,
      msg: errorData.msg,
    });

    if (createResponse.status === 422 && errorData.error_code === 'phone_exists') {
      // User exists in Supabase but not in our DB - edge case, shouldn't happen
      console.error('[Auth] User exists in Supabase but not in our DB. Phone:', phone.slice(0, -4) + '****');
    }

    return null;
  } catch (error) {
    console.error('[Auth] Supabase user lookup/create exception:', error);
    return null;
  }
}

/**
 * Generate JWT session tokens signed with HS256.
 * Uses the JWT secret directly as a string.
 */
function generateSupabaseSession(userId: string, phone: string): {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
} {
  if (!SUPABASE_JWT_SECRET) {
    throw new Error('Missing SUPABASE_JWT_SECRET');
  }

  // Use secret directly as string for HS256
  const secret = SUPABASE_JWT_SECRET;

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 7776000; // 90 days
  const expiresAt = now + expiresIn;
  const refreshExpiresAt = now + 7776000; // 90 days

  const sessionId = uuidv4();
  const accessPayload = {
    aud: 'authenticated',
    exp: expiresAt,
    iat: now,
    iss: SUPABASE_URL + '/auth/v1',
    sub: userId,
    email: '',
    phone,
    phone_confirmed_at: new Date().toISOString(),
    app_metadata: {
      provider: 'phone',
      providers: ['phone'],
    },
    user_metadata: {},
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: 'otp', timestamp: now }],
    session_id: sessionId,
    is_anonymous: false,
  };

  const refreshPayload = {
    aud: 'authenticated',
    exp: refreshExpiresAt,
    iat: now,
    iss: SUPABASE_URL + '/auth/v1',
    sub: userId,
    session_id: sessionId,
  };

  const access_token = jwt.sign(accessPayload, secret, { algorithm: 'HS256' });
  const refresh_token = jwt.sign(refreshPayload, secret, { algorithm: 'HS256' });

  return {
    access_token,
    refresh_token,
    expires_in: expiresIn,
    expires_at: expiresAt,
    token_type: 'bearer',
  };
}

/**
 * Generate anonymous session tokens.
 * Anonymous users get a UUID and can use the service without phone verification.
 */
function generateAnonymousSession(): {
  user: { id: string; is_anonymous: boolean };
  session: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    expires_at: number;
    token_type: string;
  };
} {
  if (!SUPABASE_JWT_SECRET || !SUPABASE_URL) {
    throw new Error('Missing SUPABASE_JWT_SECRET or SUPABASE_URL');
  }

  // Use secret directly as string for HS256
  const secret = SUPABASE_JWT_SECRET;
  const userId = uuidv4();
  const sessionId = uuidv4();

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 7776000; // 90 days
  const expiresAt = now + expiresIn;

  const accessPayload = {
    aud: 'authenticated',
    exp: expiresAt,
    iat: now,
    iss: SUPABASE_URL + '/auth/v1',
    sub: userId,
    email: '',
    phone: '',
    app_metadata: {
      provider: 'anonymous',
      providers: ['anonymous'],
    },
    user_metadata: {},
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: 'anonymous', timestamp: now }],
    session_id: sessionId,
    is_anonymous: true,
  };

  const refreshPayload = {
    aud: 'authenticated',
    exp: expiresAt,
    iat: now,
    iss: SUPABASE_URL + '/auth/v1',
    sub: userId,
    session_id: sessionId,
  };

  const access_token = jwt.sign(accessPayload, secret, { algorithm: 'HS256' });
  const refresh_token = jwt.sign(refreshPayload, secret, { algorithm: 'HS256' });

  return {
    user: {
      id: userId,
      is_anonymous: true,
    },
    session: {
      access_token,
      refresh_token,
      expires_in: expiresIn,
      expires_at: expiresAt,
      token_type: 'bearer',
    },
  };
}

const router = Router();

/**
 * Merge resources from anonymous user to authenticated user.
 * Transfers ownership of agents, browser context, and other user data.
 */
async function mergeAnonymousUserResources(anonymousUserId: string, authenticatedUserId: string) {
  try {
    const merged: string[] = [];

    // 1. Merge agents (and their related messages, usage via FK)
    const agentResult = await prisma.agent.updateMany({
      where: { userId: anonymousUserId },
      data: { userId: authenticatedUserId },
    });
    if (agentResult.count > 0) merged.push(`${agentResult.count} agents`);

    // 2. Merge goal blueprints
    const blueprintResult = await prisma.goalBlueprint.updateMany({
      where: { userId: anonymousUserId },
      data: { userId: authenticatedUserId },
    });
    if (blueprintResult.count > 0) merged.push(`${blueprintResult.count} goal blueprints`);

    // 3. Merge browser context (delete anon's if auth user already has one)
    const authBrowserContext = await prisma.browserContext.findUnique({
      where: { userId: authenticatedUserId },
    });
    if (!authBrowserContext) {
      const browserResult = await prisma.browserContext.updateMany({
        where: { userId: anonymousUserId },
        data: { userId: authenticatedUserId },
      });
      if (browserResult.count > 0) merged.push('browser context');
    } else {
      // Auth user already has browser context, delete anon's
      await prisma.browserContext.deleteMany({
        where: { userId: anonymousUserId },
      });
    }

    if (merged.length > 0) {
      console.log(`✅ Merged from anonymous ${anonymousUserId} to ${authenticatedUserId}: ${merged.join(', ')}`);
    } else {
      console.log(`No resources to merge from anonymous user ${anonymousUserId}`);
    }
  } catch (error) {
    // Log but don't fail the auth flow - merge is best-effort
    console.error(`Failed to merge resources from ${anonymousUserId} to ${authenticatedUserId}:`, error);
  }
}

/**
 * POST /api/auth/anonymous
 * Create an anonymous session for users who haven't signed in yet.
 * This allows them to use the service without phone verification.
 */
router.post('/anonymous', async (req: Request, res: Response) => {
  try {
    const { user, session } = generateAnonymousSession();

    // Create anonymous user in our database
    await prisma.user.create({
      data: {
        userId: user.id,
        isAnonymous: true,
      },
    });

    // Give anonymous users $1 initial credit so they can try the service
    await createInitialCredit(user.id);

    console.log(`✅ Created anonymous user ${user.id} with $1 initial credit`);

    res.json({
      success: true,
      user,
      session,
    });
  } catch (error) {
    console.error('[Auth] Anonymous session error:', error);
    res.status(500).json({ error: 'Failed to create anonymous session' });
  }
});

/**
 * POST /api/auth/send-otp
 * Send OTP to phone number via Twilio Verify
 */
router.post('/send-otp', async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Send OTP via Twilio Verify
    const result = await sendTwilioVerifyOTP(phone);

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to send OTP' });
    }

    res.json({ success: true, message: 'OTP sent' });
  } catch (error) {
    console.error('[Auth] Send OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

/**
 * POST /api/auth/verify-otp
 * Verify OTP via Twilio Verify, create user record, initialize credit
 *
 * Flow:
 * 1. Verify OTP with Twilio Verify
 * 2. Find or create Supabase user via Admin API
 * 3. Generate JWT session tokens
 * 4. Create/update our DB user record
 */
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const { phone, token, anonymousUserId, firstName, lastName } = req.body;

    if (!phone || !token) {
      return res.status(400).json({ error: 'Phone and OTP token are required' });
    }

    // Step 1: Verify OTP with Twilio Verify
    const verifyResult = await checkTwilioVerifyOTP(phone, token);

    if (!verifyResult.approved) {
      console.error('[Auth] OTP verification failed:', {
        phone: phone.slice(0, -4) + '****',
        error: verifyResult.error,
      });
      return res.status(400).json({ error: verifyResult.error || 'Invalid OTP' });
    }

    // Step 2: Find or create Supabase user
    const supabaseUser = await findOrCreateSupabaseUser(phone);

    if (!supabaseUser) {
      console.error('[Auth] Failed to find/create Supabase user');
      return res.status(500).json({ error: 'Failed to create user session' });
    }

    const { userId, isNew: isNewSupabaseUser } = supabaseUser;

    // Step 3: Generate JWT session tokens
    const session = generateSupabaseSession(userId, phone);

    // Step 4: Create/update our DB user record
    const existingUser = await prisma.user.findUnique({
      where: { userId },
    });

    if (!existingUser) {
      // Build the full name from first + last if provided
      const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;

      // Create user record
      await prisma.user.create({
        data: {
          userId,
          phone,
          name: fullName,
          isAnonymous: false,
        },
      });
      console.log(`✅ Created user record for ${userId} with phone ${phone.slice(0, -4)}****${fullName ? ` and name ${fullName}` : ''}`);

      // Give signup bonus credit for completing phone verification
      await createSignupBonusCredit(userId);
      console.log(`✅ Created signup bonus credit for user ${userId}`);

      // Merge agents from anonymous user if provided
      if (anonymousUserId && anonymousUserId !== userId) {
        await mergeAnonymousUserResources(anonymousUserId, userId);
      }
    } else {
      // User exists - update to mark as non-anonymous and add phone/name
      const updates: { phone?: string; name?: string; isAnonymous?: boolean } = {};

      if (!existingUser.phone && phone) {
        updates.phone = phone;
      }

      // Update name if not already set and we have a new name
      if (!existingUser.name && (firstName || lastName)) {
        const fullName = [firstName, lastName].filter(Boolean).join(' ');
        if (fullName) {
          updates.name = fullName;
        }
      }

      // If they were anonymous before, mark as non-anonymous and give signup bonus
      if (existingUser.isAnonymous) {
        updates.isAnonymous = false;

        await prisma.user.update({
          where: { userId },
          data: updates,
        });

        // Give signup bonus for converting from anonymous to authenticated
        await createSignupBonusCredit(userId);
        console.log(`✅ Converted anonymous user ${userId} to authenticated, gave signup bonus`);
      } else if (Object.keys(updates).length > 0) {
        await prisma.user.update({
          where: { userId },
          data: updates,
        });
        console.log(`✅ Updated user ${userId}:`, updates);
      } else {
        console.log(`User ${userId} already exists and is authenticated`);
      }

      // Merge agents from anonymous user if provided (returning user who had an anon session)
      if (anonymousUserId && anonymousUserId !== userId) {
        await mergeAnonymousUserResources(anonymousUserId, userId);
      }
    }

    // Return the session data to frontend (same shape as before)
    res.json({
      success: true,
      user: {
        id: userId,
        phone,
        is_anonymous: false,
      },
      session,
    });
  } catch (error) {
    console.error('[Auth] Verify OTP error:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

/**
 * POST /api/auth/complete-onboarding
 * Mark onboarding as complete and send welcome SMS (mac-app flow)
 *
 * This endpoint is called when the user completes the mac-app onboarding flow.
 * It sets onboardingCompletedAt and sends a welcome SMS.
 */
router.post('/complete-onboarding', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get user to check if already onboarded and get their info
    const user = await prisma.user.findUnique({
      where: { userId },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if already onboarded
    if (user.onboardingCompletedAt) {
      console.log(`User ${userId} already completed onboarding at ${user.onboardingCompletedAt}`);
      return res.json({
        success: true,
        alreadyCompleted: true,
        onboardingCompletedAt: user.onboardingCompletedAt,
      });
    }

    // Mark onboarding as complete
    const updatedUser = await prisma.user.update({
      where: { userId },
      data: { onboardingCompletedAt: new Date() },
    });

    console.log(`✅ Marked onboarding complete for user ${userId}`);

    // Send welcome MMS with personalized vCard if user has a phone number
    if (user.phone) {
      const firstName = user.name?.split(' ')[0] || 'there';
      const personalizedVcardUrl = getPersonalizedVcardUrl(userId);
      sendMms(user.phone, SMS_TEMPLATES.welcome(firstName), personalizedVcardUrl).catch((error) => {
        console.error(`⚠️ Failed to send welcome MMS to user ${userId}:`, error);
      });
      console.log(`✅ Sending welcome MMS with personalized vCard to user ${userId}`);
    }

    res.json({
      success: true,
      alreadyCompleted: false,
      onboardingCompletedAt: updatedUser.onboardingCompletedAt,
    });
  } catch (error) {
    console.error('Complete onboarding error:', error);
    res.status(500).json({ error: 'Failed to complete onboarding' });
  }
});

export default router;
