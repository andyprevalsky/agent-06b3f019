/**
 * People domain service — business logic for people CRUD, search, and messages.
 *
 * Embedding generation (OpenAI text-embedding-3-small) is temporarily disabled.
 * Person create/update stores `null` for the embedding column, and search
 * returns an empty array since semantic match is unavailable without
 * embeddings. Falls back to no results rather than blowing up the caller.
 */

import type { PersonSignals } from '../../providers/embeddings';
import {
  type PersonData,
  findCollision,
  mergePersonRecords,
} from '../../providers/personCollision';
import * as repo from './repo';
import { ALLOWED_SORT_COLUMNS, type PaginationInfo, ValidationError, NotFoundError } from './types';
import { DEFAULT_PEOPLE_LIMIT, MAX_PEOPLE_LIMIT } from './config';

// Re-export message functions from the split file
export { getPersonMessages, getRecentMessages } from './service.messages';

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

export async function searchPeople(userId: string, querySignals: PersonSignals, limit?: number) {
  const hasAnyCriteria = Object.entries(querySignals).some(([_key, value]) => {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
  });

  if (!hasAnyCriteria) {
    throw new ValidationError(
      'At least one search criterion is required (name, profession, skills, etc.)'
    );
  }

  // Semantic search depends on OpenAI embeddings, which are temporarily
  // disabled. Treat "no embedding" as "no semantic match" and return an
  // empty result set rather than calling OpenAI.
  void userId;
  void limit;
  return {
    query: querySignals,
    results: [],
    count: 0,
  };
}

// ---------------------------------------------------------------------------
// Create / upsert person
// ---------------------------------------------------------------------------

export async function createOrMergePerson(userId: string, personData: PersonData) {
  if (
    personData.first_name === undefined ||
    personData.first_name === '' ||
    personData.last_name === undefined ||
    personData.last_name === ''
  ) {
    throw new ValidationError('first_name and last_name are required');
  }

  const collision = await findCollision(userId, personData);

  if (
    collision.isDuplicate &&
    collision.existingPersonId !== undefined &&
    collision.existingPersonId !== null
  ) {
    const merged = await mergePersonRecords(collision.existingPersonId, personData);
    // Embedding generation is temporarily disabled; mergePersonRecords already
    // updated the row, so just return it as-is.
    return { person: merged, merged: true, reason: collision.reason };
  }

  const person = await repo.createPerson({
    userId,
    firstName: personData.first_name,
    lastName: personData.last_name,
    age: personData.age,
    location: personData.location,
    profession: personData.profession,
    company: personData.company,
    title: personData.title,
    industry: personData.industry,
    email: personData.email,
    phoneNumber: personData.phoneNumber,
    linkedinUrl: personData.linkedinUrl,
    instagramHandle: personData.instagramHandle,
    facebookUrl: personData.facebookUrl,
    twitterHandle: personData.twitterHandle,
    relation: personData.relation,
    communicationFrequency: personData.communication_frequency,
    relationshipQuality: personData.relationship_quality,
    skills: personData.skills ?? [],
    interests: personData.interests ?? [],
    totalOnlineReach: personData.total_online_reach,
    estimatedNetWorthUsd: personData.estimated_net_worth_usd,
    estimatedWorldPowerRanking: personData.estimated_world_power_ranking,
    currentBandwidth: personData.current_bandwidth,
    contactStatus: personData.contact_status,
    networkOrientation: personData.network_orientation,
    notes: personData.notes,
    emailAddresses: personData.emailAddresses ?? [],
  });

  return { person, merged: false };
}

// ---------------------------------------------------------------------------
// List people (paginated, sorted, searchable)
// ---------------------------------------------------------------------------

export async function listPeople(
  userId: string,
  opts: {
    page?: number;
    limit?: number;
    sort?: string;
    sortDirection?: string;
    search?: string;
  }
) {
  const page = opts.page !== undefined && opts.page !== null ? opts.page : 1;
  const limit = Math.min(
    opts.limit !== undefined && opts.limit !== null ? opts.limit : DEFAULT_PEOPLE_LIMIT,
    MAX_PEOPLE_LIMIT
  );
  const skip = (page - 1) * limit;
  const search = (opts.search ?? '').trim();

  const sortColumn = ALLOWED_SORT_COLUMNS[opts.sort ?? ''] ?? '"messagesExchanged"';
  const sortDirection = opts.sortDirection === 'asc' ? 'ASC' : 'DESC';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw SQL params for $queryRawUnsafe
  const params: any[] = [userId];
  let whereClause = `p."userId" = $1`;
  if (search !== '') {
    const searchPattern = `%${search}%`;
    params.push(searchPattern);
    const searchParam = `$${params.length}`;
    whereClause += ` AND (
      p."firstName" ILIKE ${searchParam}
      OR p."lastName" ILIKE ${searchParam}
      OR p."email" ILIKE ${searchParam}
      OR p."phoneNumber" ILIKE ${searchParam}
      OR p."company" ILIKE ${searchParam}
      OR p."title" ILIKE ${searchParam}
      OR p."communicationFrequency" ILIKE ${searchParam}
      OR (p."firstName" || ' ' || p."lastName") ILIKE ${searchParam}
    )`;
  }

  let orderClause: string;
  if (opts.sort === 'communicationFrequency') {
    const freqOrder = `CASE p."communicationFrequency"
      WHEN 'daily' THEN 0
      WHEN 'weekly' THEN 1
      WHEN 'monthly' THEN 2
      WHEN 'yearly' THEN 3
      WHEN 'rarely' THEN 4
      ELSE 99
    END`;
    orderClause = `${freqOrder} ${sortDirection}, "lastMessageAt" DESC NULLS LAST`;
  } else {
    orderClause = `${sortColumn} ${sortDirection} NULLS LAST, "lastMessageAt" DESC NULLS LAST`;
  }

  const total = await repo.countPeople(whereClause, params);

  params.push(limit, skip);
  const peopleWithCounts = await repo.listPeople(whereClause, orderClause, params);

  const totalPages = Math.ceil(total / limit);

  const people = peopleWithCounts.map(
    ({ lastMessageAt: _, ...rest }: Record<string, unknown>) => rest
  );

  const pagination: PaginationInfo = { page, limit, total, totalPages };

  return { people, pagination };
}

// ---------------------------------------------------------------------------
// Get single person
// ---------------------------------------------------------------------------

export async function getPersonById(id: string, userId: string) {
  const person = await repo.findPersonById(id, userId);
  if (person === null || person === undefined) {
    throw new NotFoundError('Person not found');
  }
  return person;
}

// ---------------------------------------------------------------------------
// Delete person
// ---------------------------------------------------------------------------

export async function deletePerson(id: string, userId: string) {
  const person = await repo.findPersonById(id, userId);
  if (person === null || person === undefined) {
    throw new NotFoundError('Person not found');
  }
  await repo.deletePerson(id);
}

// Re-export error classes so existing consumers of service.ts still work
export { ValidationError, NotFoundError } from './types';
