/**
 * Auth Routes
 * 
 * Handles OTP verification with user initialization
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { createInitialCredit } from '../lib/credits';

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
 * Verify OTP, create user record, and initialize $5 credit
 */
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const { phone, token } = req.body;

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
        'apikey': supabaseKey,
      },
      body: JSON.stringify({
        type: 'sms',
        phone,
        token,
      }),
    });

    const data = await response.json() as VerifyOtpResponse;

    if (!response.ok) {
      console.error('Supabase verify error:', data);
      return res.status(response.status).json({ 
        error: data.error_description || data.msg || 'Invalid OTP' 
      });
    }

    // OTP verified successfully - now create user record and initialize credit
    if (data.user?.id) {
      const userId = data.user.id;

      // Check if user already exists in our database
      const existingUser = await prisma.user.findUnique({
        where: { userId },
      });

      if (!existingUser) {
        // Create user record
        await prisma.user.create({
          data: { userId },
        });
        console.log(`✅ Created user record for ${userId}`);

        // Initialize $5 credit for new user
        await createInitialCredit(userId);
        console.log(`✅ Initialized $5 credit for new user ${userId}`);
      } else {
        console.log(`User ${userId} already exists, skipping initialization`);
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

