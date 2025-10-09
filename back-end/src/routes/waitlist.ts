import { Router } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

// POST /api/waitlist - Join the waitlist (no auth required)
router.post('/', async (req, res) => {
  try {
    const { name, email, variant } = req.body;

    // Validate inputs
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Insert into Waitlist table
    try {
      const waitlistEntry = await prisma.waitlist.create({
        data: {
          name: name.trim(),
          email: email.trim().toLowerCase(),
          variant: variant || null,
        },
      });

      res.json({
        success: true,
        message: "You're on the waitlist!",
        alreadyRegistered: false,
      });
    } catch (dbError: any) {
      // Handle duplicate email (unique constraint violation)
      if (dbError.code === 'P2002') {
        return res.json({
          success: true,
          message: "You're already on the waitlist!",
          alreadyRegistered: true,
        });
      }
      throw dbError;
    }
  } catch (error) {
    console.error('Waitlist join error:', error);
    res.status(500).json({ error: 'Failed to join waitlist. Please try again.' });
  }
});

export default router;

