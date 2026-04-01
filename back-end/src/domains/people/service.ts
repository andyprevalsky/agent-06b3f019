/**
 * People domain service — business logic for people CRUD, search, and messages.
 */

import {
  type PersonSignals,
  searchPeopleBySignals,
  getEmbedding,
  buildPersonEmbeddingText,
} from '../../providers/embeddings';
import {
  type PersonData,
  findCollision,
  mergePersonRecords,
} from '../../providers/personCollision';
import * as repo from './repo';
import { ALLOWED_SORT_COLUMNS, type PaginationInfo } from './types';
import { DEFAULT_PEOPLE_LIMIT, MAX_PEOPLE_LIMIT, DEFAULT_SEARCH_LIMIT } from './config';

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

  const resolvedLimit = limit !== null && limit !== undefined ? limit : DEFAULT_SEARCH_LIMIT;
  const results = await searchPeopleBySignals(userId, querySignals, resolvedLimit);

  return {
    query: querySignals,
    results,
    count: results.length,
  };
}

// ---------------------------------------------------------------------------
// Create / upsert person — helpers
// ---------------------------------------------------------------------------

function buildMergedSignals(
  merged: Awaited<ReturnType<typeof mergePersonRecords>>,
  personData: PersonData
): PersonSignals {
  return {
    first_name: merged.firstName ?? personData.first_name,
    last_name: merged.lastName ?? personData.last_name,
    age: merged.age ?? undefined,
    location: merged.location ?? undefined,
    profession: merged.profession ?? undefined,
    company: merged.company ?? undefined,
    title: merged.title ?? undefined,
    industry: merged.industry ?? undefined,
    relation: merged.relation ?? undefined,
    communication_frequency: merged.communicationFrequency ?? undefined,
    relationship_quality: merged.relationshipQuality ?? undefined,
    skills: (merged.skills as string[]) ?? undefined,
    interests: (merged.interests as string[]) ?? undefined,
    total_online_reach: merged.totalOnlineReach ?? undefined,
    estimated_net_worth_usd: merged.estimatedNetWorthUsd ?? undefined,
    estimated_world_power_ranking: merged.estimatedWorldPowerRanking ?? undefined,
    current_bandwidth: merged.currentBandwidth ?? undefined,
    contact_status: merged.contactStatus ?? undefined,
    network_orientation: merged.networkOrientation ?? undefined,
    notes: merged.notes ?? undefined,
  };
}

function buildNewPersonSignals(personData: PersonData): PersonSignals {
  return {
    first_name: personData.first_name,
    last_name: personData.last_name,
    age: personData.age,
    location: personData.location,
    profession: personData.profession,
    company: personData.company,
    title: personData.title,
    industry: personData.industry,
    relation: personData.relation,
    communication_frequency: personData.communication_frequency,
    relationship_quality: personData.relationship_quality,
    skills: personData.skills,
    interests: personData.interests,
    total_online_reach: personData.total_online_reach,
    estimated_net_worth_usd: personData.estimated_net_worth_usd,
    estimated_world_power_ranking: personData.estimated_world_power_ranking,
    current_bandwidth: personData.current_bandwidth,
    contact_status: personData.contact_status,
    network_orientation: personData.network_orientation,
    notes: personData.notes,
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
    const signals = buildMergedSignals(merged, personData);
    const embeddingText = buildPersonEmbeddingText(signals);
    const embedding = await getEmbedding(embeddingText, userId);
    const updated = await repo.updatePersonEmbedding(merged.id, embedding);
    return { person: updated, merged: true, reason: collision.reason };
  }

  const signals = buildNewPersonSignals(personData);
  const embeddingText = buildPersonEmbeddingText(signals);
  const embedding = await getEmbedding(embeddingText, userId);

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
    embedding,
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

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
