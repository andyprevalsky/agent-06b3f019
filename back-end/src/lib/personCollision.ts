import { PrismaClient, Person } from '@prisma/client';
import { MessageRecord } from '../types/person';

const prisma = new PrismaClient();

export interface CollisionResult {
  isDuplicate: boolean;
  existingPersonId?: string;
  confidence: number; // 0-1
  reason?: string;
}

export interface PersonData {
  first_name: string;
  last_name: string;
  email?: string;
  phoneNumber?: string;
  age?: number;
  location?: string;
  profession?: string;
  company?: string;
  title?: string;
  industry?: string;
  relation?: string;
  communication_frequency?: string;
  relationship_quality?: string;
  skills?: string[];
  interests?: string[];
  total_online_reach?: number;
  estimated_net_worth_usd?: number;
  estimated_world_power_ranking?: number;
  current_bandwidth?: string;
  contact_status?: string;
  network_orientation?: string;
  notes?: string;
  linkedinUrl?: string;
  instagramHandle?: string;
  facebookUrl?: string;
  twitterHandle?: string;
  emailAddresses?: string[];
  iMessageHistory?: MessageRecord[];
  whatsappHistory?: MessageRecord[];
  emailHistory?: MessageRecord[];
  telegramHistory?: MessageRecord[];
  twitterHistory?: MessageRecord[];
  instagramDmHistory?: MessageRecord[];
  messengerHistory?: MessageRecord[];
}

/**
 * Check if person already exists in database for this user
 * 
 * CRITICAL: Checks userId + (email OR phone) for uniqueness
 * - People can have multiple emails, so we check both primary email and emailAddresses array
 * - Database has unique constraint on (userId, phoneNumber) only
 * 
 * Future implementation will:
 * - Fuzzy match on name (Levenshtein distance)
 * - Semantic similarity on message history
 */
export async function findCollision(
  userId: string,
  person: PersonData
): Promise<CollisionResult> {
  // Check all emails (primary + additional)
  const emailsToCheck: string[] = [];
  if (person.email) emailsToCheck.push(person.email);
  if (person.emailAddresses) emailsToCheck.push(...person.emailAddresses);
  
  if (emailsToCheck.length > 0) {
    // Find any person with matching email in either email field or emailAddresses array
    const existingByEmail = await prisma.person.findFirst({
      where: {
        userId,
        OR: [
          { email: { in: emailsToCheck } },
          {
            emailAddresses: {
              array_contains: emailsToCheck,
            },
          },
        ],
      },
    });
    
    if (existingByEmail) {
      return {
        isDuplicate: true,
        existingPersonId: existingByEmail.id,
        confidence: 1.0,
        reason: 'Matching email found',
      };
    }
  }
  
  // Exact match on userId + phone number
  if (person.phoneNumber) {
    try {
      const existing = await prisma.person.findUnique({
        where: {
          userId_phoneNumber: {
            userId,
            phoneNumber: person.phoneNumber,
          },
        },
      });
      
      if (existing) {
        return {
          isDuplicate: true,
          existingPersonId: existing.id,
          confidence: 1.0,
          reason: 'Exact phone match for this user',
        };
      }
    } catch (error) {
      // Ignore unique constraint errors (person doesn't exist yet)
    }
  }
  
  // TODO: Implement fuzzy name matching (Levenshtein distance)
  // TODO: Implement semantic similarity on message history
  
  return {
    isDuplicate: false,
    confidence: 0,
  };
}

/**
 * Merge two person records (placeholder)
 * 
 * Called when inserting a person that matches an existing person for this user.
 * 
 * Strategy:
 * - Keep the existing record ID
 * - Merge message histories (combine and dedupe)
 * - Update fields with new data (prefer non-null values)
 * - Regenerate embedding with merged data
 * - Update timestamps
 */
export async function mergePersonRecords(
  existingPersonId: string,
  newPersonData: PersonData
): Promise<Person> {
  console.log(`Merging person records: existing=${existingPersonId}`);
  
  // Fetch existing record
  const existing = await prisma.person.findUnique({
    where: { id: existingPersonId },
  });
  
  if (!existing) {
    throw new Error(`Existing person ${existingPersonId} not found`);
  }
  
  // Helper to merge arrays and dedupe
  const mergeArrays = (existingArr: any, newArr: any[]): any[] => {
    const existing = Array.isArray(existingArr) ? existingArr : [];
    const combined = [...existing, ...newArr];
    
    // Simple deduplication by stringifying objects
    const seen = new Set<string>();
    return combined.filter(item => {
      const key = JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  
  // Message histories are now stored in MessageRecord model (not Json fields)
  // TODO: Implement MessageRecord merging if needed
  
  const emailAddresses = mergeArrays(
    existing.emailAddresses,
    newPersonData.emailAddresses || []
  );
  
  const skills = mergeArrays(
    existing.skills,
    newPersonData.skills || []
  );
  
  const interests = mergeArrays(
    existing.interests,
    newPersonData.interests || []
  );
  
  // Update with merged data (prefer non-null new values over existing)
  const updated = await prisma.person.update({
    where: { id: existingPersonId },
    data: {
      firstName: newPersonData.first_name || existing.firstName,
      lastName: newPersonData.last_name || existing.lastName,
      age: newPersonData.age ?? existing.age,
      location: newPersonData.location || existing.location,
      profession: newPersonData.profession || existing.profession,
      company: newPersonData.company || existing.company,
      title: newPersonData.title || existing.title,
      industry: newPersonData.industry || existing.industry,
      email: newPersonData.email || existing.email,
      phoneNumber: newPersonData.phoneNumber || existing.phoneNumber,
      linkedinUrl: newPersonData.linkedinUrl || existing.linkedinUrl,
      instagramHandle: newPersonData.instagramHandle || existing.instagramHandle,
      facebookUrl: newPersonData.facebookUrl || existing.facebookUrl,
      twitterHandle: newPersonData.twitterHandle || existing.twitterHandle,
      relation: newPersonData.relation || existing.relation,
      communicationFrequency: newPersonData.communication_frequency || existing.communicationFrequency,
      relationshipQuality: newPersonData.relationship_quality || existing.relationshipQuality,
      skills,
      interests,
      totalOnlineReach: newPersonData.total_online_reach ?? existing.totalOnlineReach,
      estimatedNetWorthUsd: newPersonData.estimated_net_worth_usd ?? existing.estimatedNetWorthUsd,
      estimatedWorldPowerRanking: newPersonData.estimated_world_power_ranking ?? existing.estimatedWorldPowerRanking,
      currentBandwidth: newPersonData.current_bandwidth || existing.currentBandwidth,
      contactStatus: newPersonData.contact_status || existing.contactStatus,
      networkOrientation: newPersonData.network_orientation || existing.networkOrientation,
      notes: newPersonData.notes || existing.notes,
      emailAddresses,
      // Note: embedding will be regenerated by the caller if needed
      // Note: message histories now stored in MessageRecord model
    },
  });
  
  console.log(`Person records merged successfully: ${existingPersonId}`);
  
  return updated;
}


