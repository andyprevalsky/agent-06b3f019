import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import OpenAI from 'openai';

const router = Router();

// OpenAI client for embeddings
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper function to get embeddings
async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });

  return response.data[0].embedding;
}

/**
 * Search blueprints by goal similarity using embeddings
 * POST /api/blueprints/search
 * Auth: API Key (internal service-to-service)
 */
router.post('/search', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { goal, limit = 3, user_id } = req.body;
    // For internal calls (API key), accept user_id from body
    // For user calls (JWT), extract from token
    const userId = req.isInternal ? user_id : (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: user_id required' });
    }

    if (!goal) {
      return res.status(400).json({ error: 'Goal is required' });
    }

    // Fetch all user's blueprints with embeddings for similarity search
    const blueprints = await prisma.goalBlueprint.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100, // Limit to recent 100
      select: {
        id: true,
        userId: true,
        title: true,
        embedding: true,
        blueprint: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (blueprints.length === 0) {
      return res.json([]);
    }

    // Semantic search using pre-computed embeddings
    try {
      // Generate embedding for the query goal only
      const queryEmbedding = await getEmbedding(goal);

      // Filter blueprints that have embeddings (skip any without)
      const blueprintsWithEmbeddings = blueprints.filter(bp => bp.embedding);

      if (blueprintsWithEmbeddings.length === 0) {
        return res.json([]);
      }

      // Calculate cosine similarity using pre-computed embeddings
      const withSimilarity = blueprintsWithEmbeddings.map((bp) => {
        const similarity = cosineSimilarity(queryEmbedding, bp.embedding as number[]);
        return { ...bp, similarity };
      });

      // Filter by minimum similarity threshold and return top K
      const SIMILARITY_THRESHOLD = 0.38;
      const topResults = withSimilarity
        .filter(bp => bp.similarity >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit)
        .map(({ similarity, embedding, ...bp }) => bp); // Remove similarity score and embedding from response

      res.json(topResults);
    } catch (embeddingError) {
      console.error('Embeddings failed:', embeddingError);
      // Return empty array if embeddings fail
      res.json([]);
    }
  } catch (error) {
    console.error('Blueprint search error:', error);
    res.status(500).json({ error: 'Failed to search blueprints' });
  }
});

/**
 * Save a new blueprint
 * POST /api/blueprints
 * Auth: API Key (internal service-to-service)
 */
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { title, blueprint, user_id } = req.body;
    // For internal calls (API key), accept user_id from body
    // For user calls (JWT), extract from token
    const userId = req.isInternal ? user_id : (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: user_id required' });
    }

    if (!title || !blueprint) {
      return res.status(400).json({ error: 'Title and blueprint are required' });
    }

    // Generate and store embedding for the goal/title (required)
    let embedding: number[];
    try {
      embedding = await getEmbedding(title);
    } catch (embeddingError) {
      console.error('Failed to generate embedding for blueprint:', embeddingError);
      return res.status(500).json({ error: 'Failed to generate embedding for blueprint' });
    }

    const saved = await prisma.goalBlueprint.create({
      data: {
        userId,
        title,
        embedding: embedding,
        blueprint,
      },
    });

    res.status(201).json(saved);
  } catch (error) {
    console.error('Blueprint save error:', error);
    res.status(500).json({ error: 'Failed to save blueprint' });
  }
});

/**
 * Get user's blueprints
 * GET /api/blueprints
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const blueprints = await prisma.goalBlueprint.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json(blueprints);
  } catch (error) {
    console.error('Blueprint list error:', error);
    res.status(500).json({ error: 'Failed to list blueprints' });
  }
});

/**
 * Delete a blueprint
 * DELETE /api/blueprints/:id
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify ownership
    const blueprint = await prisma.goalBlueprint.findFirst({
      where: { id, userId },
    });

    if (!blueprint) {
      return res.status(404).json({ error: 'Blueprint not found' });
    }

    await prisma.goalBlueprint.delete({
      where: { id },
    });

    res.status(204).send();
  } catch (error) {
    console.error('Blueprint delete error:', error);
    res.status(500).json({ error: 'Failed to delete blueprint' });
  }
});

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

export default router;

