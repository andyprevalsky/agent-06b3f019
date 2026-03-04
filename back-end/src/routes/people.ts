import express, { Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { searchPeopleBySignals, PersonSignals, getEmbedding, buildPersonEmbeddingText } from '../lib/embeddings';
import { findCollision, mergePersonRecords, PersonData } from '../lib/personCollision';
import { MessageRecord } from '../types/person';
import { prisma } from '../lib/prisma';

const router = express.Router();

/**
 * POST /api/people/search
 * 
 * Search for people in user's network matching the given signals
 * 
 * Body: PersonSignals object (18 signals)
 * Returns: Array of matching people with similarity scores
 */
router.post('/search', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    // For internal calls (API key auth), get user_id from X-User-Id header
    // For user calls (JWT auth), get from req.user
    const userId = req.isInternal 
      ? (req.headers['x-user-id'] as string) 
      : req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    const querySignals: PersonSignals = req.body;
    
    // Validate that at least one search criterion is provided
    const hasAnyCriteria = Object.entries(querySignals).some(([key, value]) => {
      if (value === null || value === undefined) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'string') return value.trim().length > 0;
      return true;
    });
    
    if (!hasAnyCriteria) {
      return res.status(400).json({
        error: 'At least one search criterion is required (name, profession, skills, etc.)',
      });
    }
    
    const limit = parseInt(req.query.limit as string) || 5;
    
    // Perform semantic search
    const results = await searchPeopleBySignals(userId, querySignals, limit);
    
    return res.json({
      query: querySignals,
      results,
      count: results.length,
    });
  } catch (error) {
    console.error('Error searching people:', error);
    return res.status(500).json({
      error: 'Failed to search people',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/people
 * 
 * Add a new person to user's network or update existing if collision detected
 * 
 * Body: PersonData object
 * Returns: Created/updated person record
 */
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    const personData: PersonData = req.body;
    
    // Validate required fields
    if (!personData.first_name || !personData.last_name) {
      return res.status(400).json({
        error: 'first_name and last_name are required',
      });
    }
    
    // Check for collision (duplicate person)
    const collision = await findCollision(userId, personData);
    
    if (collision.isDuplicate && collision.existingPersonId) {
      // Merge with existing person
      const merged = await mergePersonRecords(collision.existingPersonId, personData);
      
      // Regenerate embedding with merged data
      const signals: PersonSignals = {
        first_name: merged.firstName ?? personData.first_name,
        last_name: merged.lastName ?? personData.last_name,
        age: merged.age || undefined,
        location: merged.location || undefined,
        profession: merged.profession || undefined,
        company: merged.company || undefined,
        title: merged.title || undefined,
        industry: merged.industry || undefined,
        relation: merged.relation || undefined,
        communication_frequency: merged.communicationFrequency || undefined,
        relationship_quality: merged.relationshipQuality || undefined,
        skills: (merged.skills as string[]) || undefined,
        interests: (merged.interests as string[]) || undefined,
        total_online_reach: merged.totalOnlineReach || undefined,
        estimated_net_worth_usd: merged.estimatedNetWorthUsd || undefined,
        estimated_world_power_ranking: merged.estimatedWorldPowerRanking || undefined,
        current_bandwidth: merged.currentBandwidth || undefined,
        contact_status: merged.contactStatus || undefined,
        network_orientation: merged.networkOrientation || undefined,
        notes: merged.notes || undefined,
      };
      
      const embeddingText = buildPersonEmbeddingText(signals);
      const embedding = await getEmbedding(embeddingText, userId);
      
      const updated = await prisma.person.update({
        where: { id: merged.id },
        data: { embedding },
      });
      
      return res.json({
        person: updated,
        merged: true,
        reason: collision.reason,
      });
    }
    
    // Create new person
    const signals: PersonSignals = {
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
    
    // Generate embedding
    const embeddingText = buildPersonEmbeddingText(signals);
    const embedding = await getEmbedding(embeddingText, userId);
    
    // Create person record
    const person = await prisma.person.create({
      data: {
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
        skills: personData.skills || [],
        interests: personData.interests || [],
        totalOnlineReach: personData.total_online_reach,
        estimatedNetWorthUsd: personData.estimated_net_worth_usd,
        estimatedWorldPowerRanking: personData.estimated_world_power_ranking,
        currentBandwidth: personData.current_bandwidth,
        contactStatus: personData.contact_status,
        networkOrientation: personData.network_orientation,
        notes: personData.notes,
        embedding,
        // Message histories now stored in MessageRecord model (not Json fields)
        emailAddresses: personData.emailAddresses || [],
      },
    });
    
    return res.status(201).json({
      person,
      merged: false,
    });
  } catch (error) {
    console.error('Error creating person:', error);
    return res.status(500).json({
      error: 'Failed to create person',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/people
 * 
 * Get all people in user's network with pagination and message counts
 * 
 * Query params:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 50)
 * 
 * Returns: Paginated list sorted by messagesExchanged (descending)
 */
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    // For internal calls (API key auth), get user_id from X-User-Id header
    // For user calls (JWT auth), get from req.user
    const userId = req.isInternal 
      ? (req.headers['x-user-id'] as string) 
      : req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;
    
    // Get total count for pagination
    const total = await prisma.person.count({
      where: { userId },
    });
    
    // Get people with message counts using raw query for performance
    // We use a subquery to count MessageRecords for each person
    const peopleWithCounts = await prisma.$queryRaw<Array<any>>`
      SELECT 
        p.*
      FROM "Person" p
      WHERE p."userId" = ${userId}
      ORDER BY p."messagesExchanged" DESC
      LIMIT ${limit}
      OFFSET ${skip}
    `;
    
    const totalPages = Math.ceil(total / limit);
    
    return res.json({
      people: peopleWithCounts,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error('Error fetching people:', error);
    return res.status(500).json({
      error: 'Failed to fetch people',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/people/messages
 * 
 * Get message history for a person by phone, email, or name
 * 
 * Body:
 * - user_id: User ID (required for internal calls)
 * - phone: Phone number (E.164 format)
 * - email: Email address
 * - firstName: First name (requires lastName)
 * - lastName: Last name (requires firstName)
 * 
 * At least one identifier (phone, email, or firstName+lastName) is required.
 * 
 * Returns: Array of message records with channel info, or "No messages present" message
 */
router.post('/messages', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    // For internal calls (API key auth), get user_id from body
    // For user calls (JWT auth), get from req.user
    const { user_id, phone, email, firstName, lastName } = req.body;
    const userId = req.isInternal ? user_id : req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    // Validate that at least one identifier is provided
    const hasPhone = phone && typeof phone === 'string' && phone.trim().length > 0;
    const hasEmail = email && typeof email === 'string' && email.trim().length > 0;
    const hasFirstName = firstName && typeof firstName === 'string' && firstName.trim().length > 0;
    const hasLastName = lastName && typeof lastName === 'string' && lastName.trim().length > 0;
    const hasName = hasFirstName; // firstName alone is enough (single-name contacts like "Aya")

    if (!hasPhone && !hasEmail && !hasName) {
      return res.status(400).json({
        error: 'At least one identifier is required: phone, email, or firstName',
      });
    }
    
    // Normalize phone number for comparison (keep only digits and leading +)
    const normalizePhone = (p: string): string => {
      return p.replace(/[^\d+]/g, '');
    };
    
    // Build where clause to find the person
    const whereConditions: any[] = [];
    
    if (hasPhone) {
      // Normalize phone for matching - search for normalized version
      const normalizedPhone = normalizePhone(phone as string);
      whereConditions.push({ phoneNumber: normalizedPhone });
    }
    if (hasEmail) {
      // Email matching is case-insensitive
      whereConditions.push({ email: { equals: email as string, mode: 'insensitive' } });
    }
    if (hasName) {
      const nameCondition: any = {
        firstName: { equals: firstName as string, mode: 'insensitive' },
      };
      if (hasLastName) {
        nameCondition.lastName = { equals: lastName as string, mode: 'insensitive' };
      }
      whereConditions.push(nameCondition);
    }

    // Build person identifier string for messages
    const personIdentifier = hasName
      ? hasLastName ? `${firstName} ${lastName}` : firstName as string
      : hasEmail
        ? email as string
        : phone as string;

    // Find ALL matching people first (for disambiguation)
    const matchingPeople = await prisma.person.findMany({
      where: {
        userId,
        OR: whereConditions,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phoneNumber: true,
        email: true,
        _count: { select: { messageRecords: true } },
      },
    });

    if (matchingPeople.length === 0) {
      return res.json({
        person: null,
        messages: [],
        message: `No person found matching: ${personIdentifier}`,
      });
    }

    if (matchingPeople.length > 1) {
      // Multiple matches - return disambiguation info
      const idType = hasName ? 'name' : hasEmail ? 'email' : 'phone';
      return res.json({
        person: null,
        messages: [],
        multiple_matches: true,
        message: `Multiple people found with the ${idType}: ${personIdentifier}`,
        matches: matchingPeople.map(p => ({
          id: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          phoneNumber: p.phoneNumber,
          email: p.email,
          messageCount: p._count.messageRecords,
        })),
      });
    }

    // Single match - load with messages
    const messageLimit = parseInt(req.body.message_limit) || 50;
    const person = await prisma.person.findFirst({
      where: { id: matchingPeople[0].id },
      include: {
        messageRecords: {
          orderBy: { timestamp: 'desc' },
          take: messageLimit,
        },
      },
    });

    if (!person) {
      return res.json({
        person: null,
        messages: [],
        message: `No person found matching: ${personIdentifier}`,
      });
    }

    // Filter person object to non-null fields (exclude messageRecords relation)
    const { messageRecords, ...personRow } = person;
    const personData = Object.fromEntries(
      Object.entries(personRow).filter(([_, v]) => v !== null && v !== undefined)
    );

    if (person.messageRecords.length === 0) {
      return res.json({
        person: personData,
        messages: [],
        message: `No messages present for ${person.firstName} ${person.lastName}`,
      });
    }

    // Format message records with channel info
    const formattedMessages = person.messageRecords.map(record => ({
      channel: record.channel,
      from: record.from,
      to: record.to,
      timestamp: record.timestamp.toISOString(),
      message: record.message,
    }));

    return res.json({
      person: personData,
      messages: formattedMessages,
      count: formattedMessages.length,
    });
  } catch (error) {
    console.error('Error fetching message history:', error);
    return res.status(500).json({
      error: 'Failed to fetch message history',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/people/messages/recent
 * 
 * Get all recent messages across all people for a user
 * 
 * Query params:
 * - limit: Max messages to return (default: 200)
 * - days: Number of days to look back (default: 1, max: 30)
 * 
 * Returns: Array of message records with channel, from, to, timestamp, message
 */
router.get('/messages/recent', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    // For internal calls (API key auth), get user_id from X-User-Id header
    // For user calls (JWT auth), get from req.user
    const userId = req.isInternal 
      ? (req.headers['x-user-id'] as string) 
      : req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    const limit = parseInt(req.query.limit as string) || 200;
    // Support days parameter for extended lookback (used by user simulation)
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 1, 1), 30);
    
    // Calculate cutoff time based on days parameter
    const cutoffTime = new Date();
    cutoffTime.setDate(cutoffTime.getDate() - days);
    
    // Query MessageRecords from past N days for all of user's people
    const messages = await prisma.messageRecord.findMany({
      where: {
        person: {
          userId: userId,
        },
        timestamp: {
          gte: cutoffTime,
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: limit,
      select: {
        channel: true,
        from: true,
        to: true,
        timestamp: true,
        message: true,
      },
    });
    
    // Format messages
    const formattedMessages = messages.map(record => ({
      channel: record.channel,
      from: record.from,
      to: record.to,
      timestamp: record.timestamp.toISOString(),
      message: record.message,
    }));
    
    return res.json({
      messages: formattedMessages,
      count: formattedMessages.length,
      days: days,
    });
  } catch (error) {
    console.error('Error fetching recent messages:', error);
    return res.status(500).json({
      error: 'Failed to fetch recent messages',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/people/:id
 * 
 * Get a specific person by ID
 */
router.get('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    const { id } = req.params;
    
    const person = await prisma.person.findFirst({
      where: {
        id,
        userId, // Ensure user can only access their own people
      },
    });
    
    if (!person) {
      return res.status(404).json({
        error: 'Person not found',
      });
    }
    
    return res.json({ person });
  } catch (error) {
    console.error('Error fetching person:', error);
    return res.status(500).json({
      error: 'Failed to fetch person',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/people/:id
 * 
 * Delete a person from user's network
 */
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    const { id } = req.params;
    
    // Verify person belongs to user
    const person = await prisma.person.findFirst({
      where: { id, userId },
    });
    
    if (!person) {
      return res.status(404).json({
        error: 'Person not found',
      });
    }
    
    await prisma.person.delete({
      where: { id },
    });
    
    return res.json({
      message: 'Person deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting person:', error);
    return res.status(500).json({
      error: 'Failed to delete person',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
