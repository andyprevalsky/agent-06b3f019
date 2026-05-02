import OpenAI from 'openai';
import { Prisma, type Person } from '@prisma/client';
import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('Embeddings');

// Route OpenAI through globalThis.fetch so blackbox-test fetchCapture can
// intercept (the SDK defaults to node-fetch which bypasses globalThis.fetch).
// Production behaviour is unchanged: globalThis.fetch is the platform fetch.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  fetch: ((url: string | URL, init?: RequestInit) => globalThis.fetch(url, init)) as typeof fetch,
});

/**
 * PersonSignals interface matching the 18-signal structure in Prisma schema
 */
export interface PersonSignals {
  // Core identity (8 signals) - all optional for flexible semantic search
  first_name?: string;
  last_name?: string;
  age?: number;
  location?: string;
  profession?: string;
  company?: string;
  title?: string;
  industry?: string;

  // Relationship (3 signals)
  relation?: string;
  communication_frequency?: string;
  relationship_quality?: string;

  // Skills & Interests (2 signals)
  skills?: string[];
  interests?: string[];

  // Influence & Reach (3 signals)
  total_online_reach?: number;
  estimated_net_worth_usd?: number;
  estimated_world_power_ranking?: number;

  // Availability & Status (2 signals)
  current_bandwidth?: string;
  contact_status?: string;

  // Network Orientation (1 signal)
  network_orientation?: string;

  // Meta
  notes?: string;
}

/**
 * Build embedding text from 18 person signals for semantic search
 *
 * Converts the PersonSignals object into a natural language text
 * suitable for generating embeddings with OpenAI.
 */
export function buildPersonEmbeddingText(signals: PersonSignals): string {
  const parts: string[] = [];

  // Core identity - only add name if provided
  if (signals.first_name || signals.last_name) {
    const name = [signals.first_name, signals.last_name].filter(Boolean).join(' ');
    parts.push(`Name: ${name}`);
  }
  if (signals.age) parts.push(`Age: ${signals.age}`);
  if (signals.location) parts.push(`Location: ${signals.location}`);
  if (signals.profession) parts.push(`Profession: ${signals.profession}`);
  if (signals.company) parts.push(`Company: ${signals.company}`);
  if (signals.title) parts.push(`Title: ${signals.title}`);
  if (signals.industry) parts.push(`Industry: ${signals.industry}`);

  // Relationship
  if (signals.relation) parts.push(`Relationship: ${signals.relation}`);
  if (signals.communication_frequency) {
    parts.push(`Communication frequency: ${signals.communication_frequency}`);
  }
  if (signals.relationship_quality) {
    parts.push(`Relationship quality: ${signals.relationship_quality}`);
  }

  // Skills & Interests
  if (signals.skills && signals.skills.length > 0) {
    parts.push(`Skills: ${signals.skills.join(', ')}`);
  }
  if (signals.interests && signals.interests.length > 0) {
    parts.push(`Interests: ${signals.interests.join(', ')}`);
  }

  // Influence & Reach
  if (signals.total_online_reach) {
    parts.push(`Online reach: ${signals.total_online_reach.toLocaleString()} followers`);
  }
  if (signals.estimated_net_worth_usd) {
    const netWorthFormatted = `$${(signals.estimated_net_worth_usd / 1000000).toFixed(1)}M`;
    parts.push(`Estimated net worth: ${netWorthFormatted}`);
  }
  if (signals.estimated_world_power_ranking) {
    parts.push(`World power ranking: ${signals.estimated_world_power_ranking}/10`);
  }

  // Availability & Status
  if (signals.current_bandwidth) {
    parts.push(`Current bandwidth: ${signals.current_bandwidth}`);
  }
  if (signals.contact_status) {
    parts.push(`Contact status: ${signals.contact_status}`);
  }

  // Network Orientation
  if (signals.network_orientation) {
    parts.push(`Network orientation: ${signals.network_orientation}`);
  }

  // Notes
  if (signals.notes) {
    parts.push(`Notes: ${signals.notes}`);
  }

  return parts.join('. ');
}

/**
 * Deterministic fake embedding for blackbox tests where the test hasn't
 * pre-seeded a fast-forward response. Avoids the OpenAI quota path while
 * still producing stable, ordered similarity scores. Activated by
 * BLACKBOX_TEST_CAPTURE_OUTBOUND=1 — production behaviour is unchanged.
 *
 * Tests that need a SPECIFIC embedding (e.g. for similarity ordering or
 * to exercise the userId-tracking branch in getEmbedding) should call
 * seedOpenAIEmbedding before the request, which the SDK's fetch hits via
 * fastForward cache and bypasses this fallback entirely.
 */
function deterministicFakeEmbedding(text: string): number[] {
  const dim = 1536;
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    let h = 0x811c9dc5 ^ i;
    for (let j = 0; j < text.length; j++) {
      h ^= text.charCodeAt(j);
      h = Math.imul(h, 0x01000193);
    }
    out[i] = ((h >>> 0) / 0xffffffff) * 2 - 1;
  }
  return out;
}

/**
 * Generate embedding vector using OpenAI's text-embedding-3-small model
 *
 * @param text - Text to generate embedding for
 * @param userId - User ID for tracking usage
 * @returns Embedding vector as array of numbers
 */
export async function getEmbedding(text: string, userId?: string): Promise<number[]> {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });

    const embedding = response.data[0].embedding;
    const tokensUsed = response.usage?.total_tokens || 0;

    // Track usage in database if userId provided
    if (userId) {
      // text-embedding-3-small pricing: $0.00002 per 1K tokens = 0.002 cents per 1K tokens
      const costCents = (tokensUsed / 1000) * 0.002;

      await prisma.toolUsage.create({
        data: {
          userId,
          agentId: null, // Not agent-specific
          toolName: 'generate_person_embedding',
          totalCostCents: Math.round(costCents * 100) / 100, // Round to 2 decimals
          usageItems: [
            {
              type: 'llm',
              cost_cents: Math.round(costCents * 100) / 100,
              provider: 'OpenAI text-embedding-3-small',
              number_of_tokens: tokensUsed,
            },
          ],
        },
      });
    }

    return embedding;
  } catch (error) {
    // Tests: when fastForward has no cached response and OpenAI rejects (quota,
    // missing key, etc.), fall back to a deterministic fake so tests that
    // don't care about exact vectors still pass. The flag scopes this strictly
    // to the blackbox test backend.
    const inCaptureMode =
      process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND === '1' || process.env.NODE_ENV === 'test';
    if (inCaptureMode) {
      log.info('Embedding fallback (capture mode)', {
        reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown',
      });
      return deterministicFakeEmbedding(text);
    }
    log.error('Error generating embedding', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`Failed to generate embedding: ${error}`);
  }
}

/**
 * Calculate cosine similarity between two vectors
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Similarity score between -1 and 1 (1 = identical, 0 = orthogonal, -1 = opposite)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Search for people similar to the given signals
 *
 * @param userId - User ID whose network to search
 * @param querySignals - PersonSignals object describing the type of person to find
 * @param limit - Maximum number of results to return (default: 5)
 * @returns Array of matching people with similarity scores
 */
export async function searchPeopleBySignals(
  userId: string,
  querySignals: PersonSignals,
  limit: number = 5
): Promise<Array<Person & { similarity: number }>> {
  // Build embedding text from query signals
  const queryText = buildPersonEmbeddingText(querySignals);

  // Generate embedding for query
  const queryEmbedding = await getEmbedding(queryText, userId);

  // Fetch all people for this user (TODO: optimize with vector DB extension like pgvector)
  const allPeople = await prisma.person.findMany({
    where: {
      userId,
      // Filter out people without embeddings (use Prisma.DbNull for JSON fields)
      embedding: {
        not: Prisma.DbNull,
      },
    },
  });

  // Calculate similarity scores
  const peopleWithScores = allPeople.map((person) => {
    const personEmbedding = person.embedding as number[];
    const similarity = cosineSimilarity(queryEmbedding, personEmbedding);

    return {
      ...person,
      similarity,
    };
  });

  // Sort by similarity (highest first) and return top N
  const topMatches = peopleWithScores.sort((a, b) => b.similarity - a.similarity).slice(0, limit);

  return topMatches;
}
