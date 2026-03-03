import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { LRUCache } from 'lru-cache';
import { prisma } from '../lib/prisma';
import { HybridAuthRequest, hybridAuth } from '../middleware/hybridAuth';

const router = Router();

// Memory entry schema
interface MemoryEntry {
  timestamp: string;
  type: string;
  message_id?: string;
  content: string;
  files?: Array<{
    original_filename: string;
    mime_type: string;
  }>;
}

interface CachedMemory {
  content: MemoryEntry[];
  hash: string;
}

// LRU cache for shared memory (1 hour TTL, max 500 entries)
// Evicts least-recently-used entries when full instead of rejecting new ones
const memoryCache = new LRUCache<string, CachedMemory>({ max: 500, ttl: 3600 * 1000 });

// Token limit (30k tokens ≈ 120k chars at 4 chars/token)
const MAX_TOKEN_COUNT = 30000;
const CHARS_PER_TOKEN = 4;
const MAX_CHAR_COUNT = MAX_TOKEN_COUNT * CHARS_PER_TOKEN;

// Compute hash of content
function computeHash(content: MemoryEntry[]): string {
  const str = JSON.stringify(content);
  return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
}

// Estimate token count from string length
function estimateTokens(str: string): number {
  return Math.ceil(str.length / CHARS_PER_TOKEN);
}

// Validation schemas
const appendEntrySchema = z.object({
  entry: z.object({
    type: z.string(),
    message_id: z.string().optional(),
    content: z.string(),
    files: z.array(z.object({
      original_filename: z.string(),
      mime_type: z.string(),
    })).optional(),
  }),
});

// GET /api/memory/:busId - Get shared memory for a run
router.get('/:busId', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const { busId } = req.params;
    const clientHash = req.query.hash as string | undefined;

    // Check cache first
    const cached = memoryCache.get(busId);

    if (cached) {
      // If client has current hash, return 304
      if (clientHash && clientHash === cached.hash) {
        res.status(304).send();
        return;
      }

      // Return cached content
      res.json({
        content: cached.content,
        hash: cached.hash,
      });
      return;
    }

    // Cache miss - fetch from DB
    const memory = await prisma.sharedMemory.findUnique({
      where: { busId },
    });

    if (!memory) {
      // No memory exists yet - return empty
      const emptyContent: MemoryEntry[] = [];
      const emptyHash = computeHash(emptyContent);

      // Cache the empty state
      memoryCache.set(busId, { content: emptyContent, hash: emptyHash });

      res.json({
        content: emptyContent,
        hash: emptyHash,
      });
      return;
    }

    // Parse and cache
    const content = JSON.parse(memory.content) as MemoryEntry[];
    const hash = memory.contentHash;

    memoryCache.set(busId, { content, hash });

    // If client has current hash, return 304
    if (clientHash && clientHash === hash) {
      res.status(304).send();
      return;
    }

    res.json({
      content,
      hash,
    });
  } catch (error) {
    console.error('[Memory] GET error:', error);
    res.status(500).json({ error: 'Failed to fetch shared memory' });
  }
});

// POST /api/memory/:busId/append - Append entry to shared memory
router.post('/:busId/append', hybridAuth, async (req: HybridAuthRequest, res) => {
  try {
    const { busId } = req.params;
    const body = appendEntrySchema.parse(req.body);
    const { entry } = body;

    // Fetch current memory (or create new)
    let memory = await prisma.sharedMemory.findUnique({
      where: { busId },
    });

    let content: MemoryEntry[] = [];
    if (memory) {
      content = JSON.parse(memory.content) as MemoryEntry[];
    }

    // Deduplication: if message_id provided, check if already exists
    if (entry.message_id) {
      const exists = content.some(e => e.message_id === entry.message_id);
      if (exists) {
        // Already exists - return current hash without appending
        const hash = memory ? memory.contentHash : computeHash(content);
        res.json({ hash });
        return;
      }
    }

    // Create new entry with timestamp
    const newEntry: MemoryEntry = {
      timestamp: new Date().toISOString(),
      type: entry.type,
      ...(entry.message_id && { message_id: entry.message_id }),
      content: entry.content,
      ...(entry.files && entry.files.length > 0 && { files: entry.files }),
    };

    // Check token limit before appending
    const newContent = [...content, newEntry];
    const contentStr = JSON.stringify(newContent);
    const estimatedTokens = estimateTokens(contentStr);

    if (estimatedTokens > MAX_TOKEN_COUNT) {
      res.status(400).json({
        error: 'Memory limit exceeded',
        max_tokens: MAX_TOKEN_COUNT,
        current_tokens: estimatedTokens,
      });
      return;
    }

    // Compute new hash
    const newHash = computeHash(newContent);

    // Upsert to DB
    if (memory) {
      await prisma.sharedMemory.update({
        where: { busId },
        data: {
          content: contentStr,
          contentHash: newHash,
          tokenCount: estimatedTokens,
        },
      });
    } else {
      await prisma.sharedMemory.create({
        data: {
          busId,
          content: contentStr,
          contentHash: newHash,
          tokenCount: estimatedTokens,
        },
      });
    }

    // Update cache
    memoryCache.set(busId, { content: newContent, hash: newHash });

    console.log(`[Memory] Appended entry to busId=${busId}, type=${entry.type}, tokens=${estimatedTokens}`);

    res.json({ hash: newHash });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    console.error('[Memory] POST append error:', error);
    res.status(500).json({ error: 'Failed to append to shared memory' });
  }
});

export default router;
