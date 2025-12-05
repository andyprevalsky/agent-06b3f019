import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthRequest, authenticate } from '../middleware/auth';

const router = Router();

// Validation schema for user data
const updateUserSchema = z.object({
  name: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  encryptedPaymentInformation: z.string().optional().nullable(),
});

// GET /api/user-settings - Get user data
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    // For internal calls (API key auth), get user_id from X-User-Id header
    // For user calls (JWT auth), get from req.user
    const userId = req.isInternal 
      ? (req.headers['x-user-id'] as string) 
      : req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = await prisma.user.findUnique({
      where: { userId },
    });

    // If no user record exists, return defaults
    if (!user) {
      return res.json({
        name: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        state: null,
        postalCode: null,
        country: 'United States',
        encryptedPaymentInformation: null,
      });
    }

    res.json({
      name: user.name,
      addressLine1: user.addressLine1,
      addressLine2: user.addressLine2,
      city: user.city,
      state: user.state,
      postalCode: user.postalCode,
      country: user.country,
      encryptedPaymentInformation: user.encryptedPaymentInformation,
    });
  } catch (error) {
    console.error('Failed to fetch user data:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// PUT /api/user-settings - Update user data (upsert)
router.put('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const body = updateUserSchema.parse(req.body);

    const user = await prisma.user.upsert({
      where: { userId },
      update: {
        name: body.name,
        addressLine1: body.addressLine1,
        addressLine2: body.addressLine2,
        city: body.city,
        state: body.state,
        postalCode: body.postalCode,
        country: body.country,
        encryptedPaymentInformation: body.encryptedPaymentInformation,
      },
      create: {
        userId,
        name: body.name,
        addressLine1: body.addressLine1,
        addressLine2: body.addressLine2,
        city: body.city,
        state: body.state,
        postalCode: body.postalCode,
        country: body.country,
        encryptedPaymentInformation: body.encryptedPaymentInformation,
      },
    });

    res.json({
      name: user.name,
      addressLine1: user.addressLine1,
      addressLine2: user.addressLine2,
      city: user.city,
      state: user.state,
      postalCode: user.postalCode,
      country: user.country,
      encryptedPaymentInformation: user.encryptedPaymentInformation,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    console.error('Failed to update user data:', error);
    res.status(500).json({ error: 'Failed to update user data' });
  }
});

// PATCH /api/user-settings - Partially update user data
router.patch('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const body = updateUserSchema.parse(req.body);

    // Check if user record exists
    const existingUser = await prisma.user.findUnique({
      where: { userId },
    });

    if (!existingUser) {
      // Create new user record if it doesn't exist
      const user = await prisma.user.create({
        data: {
          userId,
          name: body.name,
          addressLine1: body.addressLine1,
          addressLine2: body.addressLine2,
          city: body.city,
          state: body.state,
          postalCode: body.postalCode,
          country: body.country,
          encryptedPaymentInformation: body.encryptedPaymentInformation,
        },
      });

      return res.json({
        name: user.name,
        addressLine1: user.addressLine1,
        addressLine2: user.addressLine2,
        city: user.city,
        state: user.state,
        postalCode: user.postalCode,
        country: user.country,
        encryptedPaymentInformation: user.encryptedPaymentInformation,
      });
    }

    // Update only provided fields
    const updateData: any = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.addressLine1 !== undefined) updateData.addressLine1 = body.addressLine1;
    if (body.addressLine2 !== undefined) updateData.addressLine2 = body.addressLine2;
    if (body.city !== undefined) updateData.city = body.city;
    if (body.state !== undefined) updateData.state = body.state;
    if (body.postalCode !== undefined) updateData.postalCode = body.postalCode;
    if (body.country !== undefined) updateData.country = body.country;
    if (body.encryptedPaymentInformation !== undefined) updateData.encryptedPaymentInformation = body.encryptedPaymentInformation;

    const user = await prisma.user.update({
      where: { userId },
      data: updateData,
    });

    res.json({
      name: user.name,
      addressLine1: user.addressLine1,
      addressLine2: user.addressLine2,
      city: user.city,
      state: user.state,
      postalCode: user.postalCode,
      country: user.country,
      encryptedPaymentInformation: user.encryptedPaymentInformation,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    console.error('Failed to update user data:', error);
    res.status(500).json({ error: 'Failed to update user data' });
  }
});

export default router;

