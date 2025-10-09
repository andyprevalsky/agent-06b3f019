import { Router } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

// GET /api/tools - Get all available tools
router.get('/', async (req, res) => {
  try {
    const tools = await prisma.tool.findMany({
      select: {
        id: true,
        name: true,
        description: true,
      },
      orderBy: {
        name: 'asc',
      },
    });

    res.json({
      tools: tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
      })),
    });
  } catch (error) {
    console.error('Get tools error:', error);
    res.status(500).json({ error: 'Failed to fetch tools' });
  }
});

export default router;

