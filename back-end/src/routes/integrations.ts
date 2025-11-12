import express, { Response } from 'express';
import { PrismaClient, IntegrationType, IntegrationStatus } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/auth';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = express.Router();
const prisma = new PrismaClient();

// Configure multer for file uploads
const upload = multer({
  dest: '/tmp/integration-uploads/',
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max file size
  },
});

/**
 * GET /api/integrations
 * 
 * Get all integrations for the authenticated user
 */
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    
    const integrations = await prisma.integration.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
    
    return res.json({
      integrations,
      count: integrations.length,
    });
  } catch (error) {
    console.error('Error fetching integrations:', error);
    return res.status(500).json({
      error: 'Failed to fetch integrations',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/integrations
 * 
 * Create or update an integration
 */
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name, type, config } = req.body;
    
    if (!name || !type) {
      return res.status(400).json({
        error: 'name and type are required',
      });
    }
    
    // Validate type enum
    if (!Object.values(IntegrationType).includes(type)) {
      return res.status(400).json({
        error: `Invalid integration type. Must be one of: ${Object.values(IntegrationType).join(', ')}`,
      });
    }
    
    // Upsert integration
    const integration = await prisma.integration.upsert({
      where: {
        userId_name: {
          userId,
          name,
        },
      },
      create: {
        userId,
        name,
        type,
        config: config || {},
        status: IntegrationStatus.NOT_CONNECTED,
      },
      update: {
        type,
        config: config || {},
        status: IntegrationStatus.CONNECTED,
        isActive: true,
      },
    });
    
    return res.json({ integration });
  } catch (error) {
    console.error('Error creating integration:', error);
    return res.status(500).json({
      error: 'Failed to create integration',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/integrations/upload
 * 
 * Upload integration data file (LinkedIn ZIP, Twitter export, iMessage db, etc.)
 * 
 * This is a placeholder endpoint - actual parsing logic will be implemented
 * in Phase 3 with integration-specific parsers.
 */
router.post('/upload', authenticate, upload.single('file') as any, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { integrationType } = req.body;
    
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded',
      });
    }
    
    if (!integrationType) {
      return res.status(400).json({
        error: 'integrationType is required',
      });
    }
    
    const filePath = req.file.path;
    const fileName = req.file.originalname;
    
    console.log(`File uploaded: ${fileName} (${req.file.size} bytes)`);
    console.log(`Integration type: ${integrationType}`);
    console.log(`File path: ${filePath}`);
    
    // Update integration status to SYNCING
    const integration = await prisma.integration.upsert({
      where: {
        userId_name: {
          userId,
          name: integrationType,
        },
      },
      create: {
        userId,
        name: integrationType,
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.SYNCING,
        config: {
          fileName,
          filePath,
          uploadedAt: new Date().toISOString(),
        },
      },
      update: {
        status: IntegrationStatus.SYNCING,
        config: {
          fileName,
          filePath,
          uploadedAt: new Date().toISOString(),
        },
      },
    });
    
    // TODO: Process the file based on integrationType
    // This will be implemented in Phase 3 with integration parsers
    // For now, just return success
    
    // Simulate async processing
    setTimeout(async () => {
      try {
        // TODO: Call appropriate parser based on integrationType
        // - parseLinkedInExport(filePath, userId)
        // - parseTwitterExport(filePath, userId)
        // - parseIMessageDb(filePath, userId)
        // etc.
        
        // For now, just update status to CONNECTED
        await prisma.integration.update({
          where: { id: integration.id },
          data: {
            status: IntegrationStatus.CONNECTED,
            isActive: true,
            lastSyncAt: new Date(),
            lastSuccessfulSyncAt: new Date(),
          },
        });
        
        // Clean up file
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Error processing integration:', error);
        await prisma.integration.update({
          where: { id: integration.id },
          data: {
            status: IntegrationStatus.SYNC_FAILED,
            lastSyncAt: new Date(),
            lastFailedSyncAt: new Date(),
            failureReason: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    }, 1000);
    
    return res.json({
      message: 'File uploaded successfully, processing in background',
      integration,
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    
    // Clean up file on error
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
    
    return res.status(500).json({
      error: 'Failed to upload file',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * PATCH /api/integrations/:name
 * 
 * Update an integration's status or config
 */
router.patch('/:name', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name } = req.params;
    const { status, isActive, config } = req.body;
    
    // Find existing integration
    const existing = await prisma.integration.findUnique({
      where: {
        userId_name: {
          userId,
          name,
        },
      },
    });
    
    if (!existing) {
      return res.status(404).json({
        error: 'Integration not found',
      });
    }
    
    // Build update data
    const updateData: any = {};
    if (status !== undefined) updateData.status = status;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (config !== undefined) updateData.config = config;
    
    const updated = await prisma.integration.update({
      where: { id: existing.id },
      data: updateData,
    });
    
    return res.json({ integration: updated });
  } catch (error) {
    console.error('Error updating integration:', error);
    return res.status(500).json({
      error: 'Failed to update integration',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/integrations/:name
 * 
 * Disconnect/delete an integration
 */
router.delete('/:name', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name } = req.params;
    
    const integration = await prisma.integration.findUnique({
      where: {
        userId_name: {
          userId,
          name,
        },
      },
    });
    
    if (!integration) {
      return res.status(404).json({
        error: 'Integration not found',
      });
    }
    
    await prisma.integration.delete({
      where: { id: integration.id },
    });
    
    return res.json({
      message: 'Integration deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting integration:', error);
    return res.status(500).json({
      error: 'Failed to delete integration',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;

