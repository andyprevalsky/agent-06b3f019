import { createHash } from '../../providers/crypto';
// eslint-disable-next-line no-restricted-imports -- domain-specific LRU cache, single consumer
import { LRUCache } from 'lru-cache';
import type { MemoryEntry, CachedMemory, AppendEntryInput } from './types';
import { MAX_TOKEN_COUNT, CHARS_PER_TOKEN, CACHE_MAX_ENTRIES, CACHE_TTL_MS } from './config';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';

const log = createLogger('Memory');

// LRU cache for shared memory
const memoryCache = new LRUCache<string, CachedMemory>({
  max: CACHE_MAX_ENTRIES,
  ttl: CACHE_TTL_MS,
});

// Compute hash of content
function computeHash(content: MemoryEntry[]): string {
  const str = JSON.stringify(content);
  return createHash('sha256').update(str).digest('hex').substring(0, 16);
}

// Estimate token count from string length
function estimateTokens(str: string): number {
  return Math.ceil(str.length / CHARS_PER_TOKEN);
}

// Error classes
export class MemoryLimitExceededError extends Error {
  public maxTokens: number;
  public currentTokens: number;

  constructor(maxTokens: number, currentTokens: number) {
    super('Memory limit exceeded');
    this.name = 'MemoryLimitExceededError';
    this.maxTokens = maxTokens;
    this.currentTokens = currentTokens;
  }
}

/**
 * Get shared memory for a bus ID.
 * Returns { content, hash } or null with a hash for 304 detection.
 */
export async function getMemory(
  busId: string,
  clientHash?: string
): Promise<{ notModified: true } | { content: MemoryEntry[]; hash: string }> {
  // Check cache first
  const cached = memoryCache.get(busId);

  if (cached !== undefined) {
    if (clientHash !== undefined && clientHash !== '' && clientHash === cached.hash) {
      return { notModified: true };
    }
    return { content: cached.content, hash: cached.hash };
  }

  // Cache miss - fetch from DB
  const memory = await repo.findMemoryByBusId(busId);

  if (memory === null) {
    // No memory exists yet - return empty
    const emptyContent: MemoryEntry[] = [];
    const emptyHash = computeHash(emptyContent);

    // Cache the empty state
    memoryCache.set(busId, { content: emptyContent, hash: emptyHash });

    return { content: emptyContent, hash: emptyHash };
  }

  // Parse and cache
  const content = JSON.parse(memory.content) as MemoryEntry[];
  const hash = memory.contentHash;

  memoryCache.set(busId, { content, hash });

  // If client has current hash, return 304
  if (clientHash !== undefined && clientHash !== '' && clientHash === hash) {
    return { notModified: true };
  }

  return { content, hash };
}

/**
 * Append an entry to shared memory for a bus ID.
 * Returns the new hash after appending.
 */
export async function appendEntry(
  busId: string,
  body: AppendEntryInput
): Promise<{ hash: string }> {
  const { entry } = body;

  // Fetch current memory (or create new)
  const memory = await repo.findMemoryByBusId(busId);

  let content: MemoryEntry[] = [];
  if (memory !== null) {
    content = JSON.parse(memory.content) as MemoryEntry[];
  }

  // Deduplication: if message_id provided, check if already exists
  if (entry.message_id !== undefined && entry.message_id !== '') {
    const exists = content.some((e) => e.message_id === entry.message_id);
    if (exists) {
      // Already exists - return current hash without appending
      const hash = memory !== null ? memory.contentHash : computeHash(content);
      return { hash };
    }
  }

  // Create new entry with timestamp
  const newEntry: MemoryEntry = {
    timestamp: new Date().toISOString(),
    type: entry.type,
    ...(entry.message_id !== undefined &&
      entry.message_id !== '' && { message_id: entry.message_id }),
    content: entry.content,
    ...(entry.files !== undefined && entry.files.length > 0 && { files: entry.files }),
  };

  // Check token limit before appending
  const newContent = [...content, newEntry];
  const contentStr = JSON.stringify(newContent);
  const estimatedTokens = estimateTokens(contentStr);

  if (estimatedTokens > MAX_TOKEN_COUNT) {
    throw new MemoryLimitExceededError(MAX_TOKEN_COUNT, estimatedTokens);
  }

  // Compute new hash
  const newHash = computeHash(newContent);

  // Upsert to DB
  if (memory !== null) {
    await repo.updateMemory(busId, contentStr, newHash, estimatedTokens);
  } else {
    await repo.createMemory(busId, contentStr, newHash, estimatedTokens);
  }

  // Update cache
  memoryCache.set(busId, { content: newContent, hash: newHash });

  log.info(`Appended entry to busId=${busId}, type=${entry.type}, tokens=${estimatedTokens}`);

  return { hash: newHash };
}
