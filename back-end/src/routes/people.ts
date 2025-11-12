import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth';
import { searchPeopleBySignals, PersonSignals, getEmbedding, buildPersonEmbeddingText } from '../lib/embeddings';
import { findCollision, mergePersonRecords, PersonData } from '../lib/personCollision';
import { MessageRecord } from '../types/person';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * POST /api/people/search
 * 
 * Search for people in user's network matching the given signals
 * 
 * Body: PersonSignals object (18 signals)
 * Returns: Array of matching people with similarity scores
 */
router.post('/search', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const querySignals: PersonSignals = req.body;
    
    // Validate required fields
    if (!querySignals.first_name || !querySignals.last_name) {
      return res.status(400).json({
        error: 'first_name and last_name are required',
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
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
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
        first_name: merged.firstName,
        last_name: merged.lastName,
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
 * Get all people in user's network
 */
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    
    const people = await prisma.person.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
    
    return res.json({
      people,
      count: people.length,
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
 * GET /api/people/:id
 * 
 * Get a specific person by ID
 */
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
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
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
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
