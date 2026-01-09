/**
 * Auth Routes
 *
 * Handles OTP verification with user initialization.
 * Anonymous users are now created via Supabase's native signInAnonymously().
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { createSignupBonusCredit } from '../lib/credits';

// Supabase API response types
interface SendOtpResponse {
  // Error fields
  error_description?: string;
  msg?: string;
}

interface VerifyOtpResponse {
  // Success fields
  user?: {
    id: string;
    phone?: string;
    email?: string;
    is_anonymous?: boolean;
  };
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  // Error fields
  error_description?: string;
  msg?: string;
}

const router = Router();

/**
 * Merge agents from anonymous user to authenticated user.
 * Transfers ownership of all agents (and their messages, usage) from the anonymous user.
 */
async function mergeAnonymousUserAgents(anonymousUserId: string, authenticatedUserId: string) {
  try {
    // Find all agents belonging to the anonymous user
    const anonymousAgents = await prisma.agent.findMany({
      where: { userId: anonymousUserId },
      select: { id: true },
    });

    if (anonymousAgents.length === 0) {
      console.log(`No agents to merge from anonymous user ${anonymousUserId}`);
      return;
    }

    // Transfer agent ownership to the authenticated user
    const result = await prisma.agent.updateMany({
      where: { userId: anonymousUserId },
      data: { userId: authenticatedUserId },
    });

    console.log(`✅ Merged ${result.count} agents from anonymous user ${anonymousUserId} to ${authenticatedUserId}`);

    // Optionally: Mark the anonymous user record for cleanup (don't delete in case of issues)
    // The anonymous user record can be cleaned up later via a batch job
  } catch (error) {
    // Log but don't fail the auth flow - agent merge is best-effort
    console.error(`Failed to merge agents from ${anonymousUserId} to ${authenticatedUserId}:`, error);
  }
}

/**
 * POST /api/auth/send-otp
 * Send OTP to phone number
 */
router.post('/send-otp', async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error('Missing Supabase configuration');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Send OTP via Supabase
    const response = await fetch(`${supabaseUrl}/auth/v1/otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
      },
      body: JSON.stringify({
        phone,
        create_user: true,
      }),
    });

    if (!response.ok) {
      const data = await response.json() as SendOtpResponse;
      console.error('Supabase OTP error:', data);
      return res.status(response.status).json({
        error: data.error_description || data.msg || 'Failed to send OTP'
      });
    }

    res.json({ success: true, message: 'OTP sent' });
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

/**
 * POST /api/auth/verify-otp
 * Verify OTP, create user record, initialize credit
 *
 * With Supabase native anonymous auth:
 * - Anonymous users have real Supabase user IDs (UUIDs)
 * - When they verify phone via standard OTP, they get a NEW user ID
 * - We merge the anonymous user's agents into the new authenticated user
 */
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const { phone, token, anonymousUserId, firstName, lastName } = req.body;

    if (!phone || !token) {
      return res.status(400).json({ error: 'Phone and OTP token are required' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error('Missing Supabase configuration');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Verify OTP with Supabase
    const response = await fetch(`${supabaseUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
      },
      body: JSON.stringify({
        type: 'sms',
        phone,
        token,
      }),
    });

    const data = (await response.json()) as VerifyOtpResponse;

    if (!response.ok) {
      console.error('Supabase verify error:', {
        status: response.status,
        data,
        phone,
        tokenLength: token?.length,
      });
      return res.status(response.status).json({
        error: data.error_description || data.msg || 'Invalid OTP',
      });
    }

    // OTP verified successfully - ensure user record exists and handle credits
    if (data.user?.id) {
      const userId = data.user.id;
      const userPhone = phone; // Phone from request (E.164 format)

      // Check if user already exists in our database
      const existingUser = await prisma.user.findUnique({
        where: { userId },
      });

      if (!existingUser) {
        // User doesn't exist in our DB - this could be:
        // 1. An anonymous user who just verified phone (their Supabase user was created by signInAnonymously)
        // 2. A brand new user who went straight to phone verification

        // Build the full name from first + last if provided
        const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;

        // Create user record
        await prisma.user.create({
          data: {
            userId,
            phone: userPhone,
            name: fullName,
            isAnonymous: false, // They just verified phone, so not anonymous anymore
          },
        });
        console.log(`✅ Created user record for ${userId} with phone ${userPhone}${fullName ? ` and name ${fullName}` : ''}`);

        // Give signup bonus credit for completing phone verification
        await createSignupBonusCredit(userId);
        console.log(`✅ Created signup bonus credit for user ${userId}`);

        // Merge agents from anonymous user if provided
        if (anonymousUserId && anonymousUserId !== userId) {
          await mergeAnonymousUserAgents(anonymousUserId, userId);
        }
      } else {
        // User exists - update to mark as non-anonymous and add phone/name
        const updates: { phone?: string; name?: string; isAnonymous?: boolean } = {};

        if (!existingUser.phone && userPhone) {
          updates.phone = userPhone;
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
          await mergeAnonymousUserAgents(anonymousUserId, userId);
        }
      }
    }

    // Return the session data to frontend
    res.json({
      success: true,
      user: data.user,
      session: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        expires_at: data.expires_at,
        token_type: data.token_type,
      },
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

export default router;
