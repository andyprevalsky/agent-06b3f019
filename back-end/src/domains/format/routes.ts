import type { AuthRequest } from '../../providers/auth';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import { generatePromptSchema } from './types';
import { generatePrompt } from './service';

const log = createLogger('Format');
const router = Router();

// POST /api/generate-llm-judge-prompt - Generate an LLM judge prompt from a goal
router.post(
  '/generate-llm-judge-prompt',
  // The router-level `authenticate` (server.ts) already set req.user: archive
  // the generation under that user's root without another auth/DB round trip.
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const body = generatePromptSchema.parse(req.body);

      const generatedPrompt = await generatePrompt(body.goal, req.user?.id);

      res.json({
        prompt: generatedPrompt,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request body', details: error.errors });
        return;
      }
      log.error('Generate prompt error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: 'Failed to generate prompt',
      });
    }
  })
);

export default router;
