import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const prisma = new PrismaClient();

/**
 * PersonSignals interface matching the 18-signal structure in Prisma schema
 */
export interface PersonSignals {
  // Core identity (8 signals)
  first_name: string;   // REQUIRED
  last_name: string;    // REQUIRED
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
  
  // Core identity
  parts.push(`Name: ${signals.first_name} ${signals.last_name}`);
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
 * Generate embedding vector using OpenAI's text-embedding-3-small model
 * 
 * @param text - Text to generate embedding for
 * @param userId - User ID for tracking usage
 * @returns Embedding vector as array of numbers
 */
export async function getEmbedding(
  text: string,
  userId?: string
): Promise<number[]> {
  const startTime = Date.now();
  
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    
    const embedding = response.data[0].embedding;
    const tokensUsed = response.usage?.total_tokens || 0;
    
    // Track usage in database if userId provided
    if (userId) {
      const endTime = Date.now();
      const durationMs = endTime - startTime;
      
      // text-embedding-3-small pricing: $0.00002 per 1K tokens = 0.002 cents per 1K tokens
      const costCents = (tokensUsed / 1000) * 0.002;
      
      await prisma.toolUsage.create({
        data: {
          userId,
          agentId: null,  // Not agent-specific
          toolName: 'generate_person_embedding',
          totalCostCents: Math.round(costCents * 100) / 100,  // Round to 2 decimals
          usageItems: [
            {
              type: 'llm',
              cost_cents: Math.round(costCents * 100) / 100,
              provider: 'OpenAI text-embedding-3-small',
              number_of_tokens: tokensUsed,
            }
          ],
        },
      });
    }
    
    return embedding;
  } catch (error) {
    console.error('Error generating embedding:', error);
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
): Promise<Array<any & { similarity: number }>> {
  // Build embedding text from query signals
  const queryText = buildPersonEmbeddingText(querySignals);
  
  // Generate embedding for query
  const queryEmbedding = await getEmbedding(queryText, userId);
  
  // Fetch all people for this user (TODO: optimize with vector DB extension like pgvector)
  const allPeople = await prisma.person.findMany({
    where: {
      userId,
      // Select all "person" rows where embedding is not null (Prisma needs 'not: undefined' for JSON fields)
      embedding: {
        not: undefined,
      },
    },
  });
  
  // Calculate similarity scores
  const peopleWithScores = allPeople.map(person => {
    const personEmbedding = person.embedding as number[];
    const similarity = cosineSimilarity(queryEmbedding, personEmbedding);
    
    return {
      ...person,
      similarity,
    };
  });
  
  // Sort by similarity (highest first) and return top N
  const topMatches = peopleWithScores
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
  
  return topMatches;
}


