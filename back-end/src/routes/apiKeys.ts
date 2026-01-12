/**
 * API Keys Routes
 * Manage Rose API keys for users
 */

import express, { Response } from 'express';
import crypto from 'crypto';
import { authenticate, AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';

const router = express.Router();

/**
 * GET /api/api-keys
 * List all API keys for the authenticated user (masked)
 */
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.user.id;

    const keys = await prisma.roseApiKey.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        apiKey: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Mask API keys - show only last 4 characters
    const maskedKeys = keys.map((key) => ({
      id: key.id,
      name: key.name,
      maskedApiKey: `...${key.apiKey.slice(-4)}`,
      createdAt: key.createdAt,
    }));

    res.json({ keys: maskedKeys });
  } catch (error) {
    console.error('Error listing API keys:', error);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

/**
 * POST /api/api-keys
 * Generate a new API key for the authenticated user
 */
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.user.id;
    const { name } = req.body;

    // Check if user has an active subscription
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
    });

    if (!subscription) {
      return res.status(403).json({
        error: 'Active subscription required',
        message: 'API access requires an active subscription. Visit roselabs.ai to subscribe.',
      });
    }

    // Generate 32-character API key (UUID without dashes)
    const apiKey = crypto.randomUUID().replace(/-/g, '');

    const newKey = await prisma.roseApiKey.create({
      data: {
        userId,
        apiKey,
        name: name || null,
      },
    });

    console.log(`✅ Generated Rose API key for user ${userId}`);

    // Return the full API key (only shown once)
    res.json({
      id: newKey.id,
      name: newKey.name,
      apiKey: newKey.apiKey,
      createdAt: newKey.createdAt,
    });
  } catch (error) {
    console.error('Error generating API key:', error);
    res.status(500).json({ error: 'Failed to generate API key' });
  }
});

/**
 * DELETE /api/api-keys/:id
 * Delete an API key
 */
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.user.id;
    const { id } = req.params;

    // Verify the key belongs to the user
    const key = await prisma.roseApiKey.findFirst({
      where: { id, userId },
    });

    if (!key) {
      return res.status(404).json({ error: 'API key not found' });
    }

    await prisma.roseApiKey.delete({
      where: { id },
    });

    console.log(`🗑️ Deleted Rose API key ${id} for user ${userId}`);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

export default router;
