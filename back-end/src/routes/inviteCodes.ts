import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

/**
 * Generate a unique 6-digit invite code
 */
function generateInviteCode(): number {
  return Math.floor(100000 + Math.random() * 900000);
}

/**
 * GET /api/invite-codes/my-code
 * Get the current user's invite code and usage stats
 */
router.get('/my-code', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.user.id;

    // Get or create user record
    let user = await prisma.user.findUnique({
      where: { userId },
      select: {
        inviteCode: true,
        inviteCodeUses: true,
      }
    });

    // If user doesn't exist or doesn't have an invite code, create one
    if (!user || !user.inviteCode) {
      let inviteCode: number;
      let isUnique = false;
      
      // Keep generating until we get a unique code
      while (!isUnique) {
        inviteCode = generateInviteCode();
        const existing = await prisma.user.findUnique({
          where: { inviteCode }
        });
        if (!existing) {
          isUnique = true;
        }
      }

      user = await prisma.user.upsert({
        where: { userId },
        create: {
          userId,
          inviteCode: inviteCode!,
          inviteCodeUses: 0,
        },
        update: {
          inviteCode: inviteCode!,
        },
        select: {
          inviteCode: true,
          inviteCodeUses: true,
        }
      });
    }

    const usesRemaining = Math.max(0, 3 - user.inviteCodeUses);

    res.json({
      inviteCode: user.inviteCode,
      uses: user.inviteCodeUses,
      usesRemaining,
    });
  } catch (error) {
    console.error('Error getting invite code:', error);
    res.status(500).json({ error: 'Failed to get invite code' });
  }
});

/**
 * POST /api/invite-codes/use
 * Use an invite code during signup
 * Body: { inviteCode: number }
 */
router.post('/use', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.user.id;
    const { inviteCode } = req.body;

    if (!inviteCode || typeof inviteCode !== 'number') {
      return res.status(400).json({ error: 'Valid invite code is required' });
    }

    // Check if user already used an invite code
    const existingUser = await prisma.user.findUnique({
      where: { userId },
      select: { usedInviteCode: true }
    });

    if (existingUser?.usedInviteCode) {
      return res.status(400).json({ error: 'You have already used an invite code' });
    }

    // MASTER INVITE CODE: 181818 bypasses all checks
    if (inviteCode === 181818) {
      await prisma.user.upsert({
        where: { userId },
        create: {
          userId,
          usedInviteCode: inviteCode,
        },
        update: {
          usedInviteCode: inviteCode,
        }
      });

      return res.json({
        success: true,
        message: 'Master invite code accepted'
      });
    }

    // Find the user who owns this invite code
    const inviter = await prisma.user.findUnique({
      where: { inviteCode },
      select: {
        userId: true,
        inviteCodeUses: true,
      }
    });

    if (!inviter) {
      return res.status(404).json({ error: 'Invalid invite code' });
    }

    // Check if the inviter has uses remaining
    if (inviter.inviteCodeUses >= 3) {
      return res.status(400).json({ error: 'This invite code has no uses remaining' });
    }

    // Use the invite code
    await prisma.$transaction([
      // Update the inviter's use count
      prisma.user.update({
        where: { inviteCode },
        data: {
          inviteCodeUses: {
            increment: 1
          }
        }
      }),
      // Update the new user to record which code they used
      prisma.user.upsert({
        where: { userId },
        create: {
          userId,
          usedInviteCode: inviteCode,
        },
        update: {
          usedInviteCode: inviteCode,
        }
      })
    ]);

    res.json({
      success: true,
      message: 'Invite code accepted'
    });
  } catch (error) {
    console.error('Error using invite code:', error);
    res.status(500).json({ error: 'Failed to use invite code' });
  }
});

/**
 * GET /api/invite-codes/check
 * Check if the current user needs to enter an invite code
 */
router.get('/check', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { userId },
      select: { usedInviteCode: true }
    });

    res.json({
      needsInviteCode: !user || user.usedInviteCode === null
    });
  } catch (error) {
    console.error('Error checking invite code:', error);
    res.status(500).json({ error: 'Failed to check invite code status' });
  }
});

export default router;

