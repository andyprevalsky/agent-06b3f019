import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { openrouter } from '../lib/openrouter';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

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

    // For now, fetch all user's blueprints and do similarity in-memory
    // TODO: Use pgvector extension for efficient similarity search
    const blueprints = await prisma.goalBlueprint.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100, // Limit to recent 100
    });

    if (blueprints.length === 0) {
      return res.json([]);
    }

    // Try semantic search with embeddings, fall back to simple text matching
    try {
      // Generate embedding for the query goal
      const embeddingResponse = await openrouter.embeddings.create({
        model: 'openai/text-embedding-3-small',
        input: goal,
      });

      const queryEmbedding = embeddingResponse.data[0].embedding;

      // Generate embeddings for all blueprint titles and calculate cosine similarity
      const blueprintEmbeddings = await Promise.all(
        blueprints.map(async (bp) => {
          const response = await openrouter.embeddings.create({
            model: 'openai/text-embedding-3-small',
            input: bp.title,
          });
          return {
            blueprint: bp,
            embedding: response.data[0].embedding,
          };
        })
      );

      // Calculate cosine similarity
      const withSimilarity = blueprintEmbeddings.map(({ blueprint, embedding }) => {
        const similarity = cosineSimilarity(queryEmbedding, embedding);
        return { ...blueprint, similarity };
      });

      // Sort by similarity and return top K
      const topResults = withSimilarity
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit)
        .map(({ similarity, ...bp }) => bp); // Remove similarity score from response

      res.json(topResults);
    } catch (embeddingError) {
      console.warn('Embeddings not available, falling back to simple search:', embeddingError);
      
      // Fall back to simple keyword matching
      const goalLower = goal.toLowerCase();
      const matchingBlueprints = blueprints
        .filter(bp => bp.title.toLowerCase().includes(goalLower))
        .slice(0, limit);
      
      // If no keyword matches, return most recent blueprints
      if (matchingBlueprints.length === 0) {
        return res.json(blueprints.slice(0, limit));
      }
      
      res.json(matchingBlueprints);
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

    const saved = await prisma.goalBlueprint.create({
      data: {
        userId,
        title,
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

