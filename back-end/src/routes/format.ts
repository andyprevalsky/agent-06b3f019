import { Router } from 'express';
import { z } from 'zod';
import { generateLLMJudgePrompt } from '../providers/openrouter';

const router = Router();

const generatePromptSchema = z.object({
  goal: z.string().min(1),
});

// POST /api/generate-llm-judge-prompt - Generate an LLM judge prompt from a goal
router.post('/generate-llm-judge-prompt', async (req, res) => {
  try {
    const body = generatePromptSchema.parse(req.body);

    const generatedPrompt = await generateLLMJudgePrompt(body.goal);

    res.json({
      prompt: generatedPrompt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    console.error('Generate prompt error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({
      error: 'Failed to generate prompt',
      details: errorMessage,
      hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY,
    });
  }
});

export default router;
