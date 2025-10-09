import { Router } from 'express';
import { z } from 'zod';
import { formatLLMJudgePrompt } from '../lib/openai';

const router = Router();

const formatPromptSchema = z.object({
  text: z.string().min(1),
});

// POST /api/format-llm-judge-prompt - Format an LLM judge prompt
router.post('/format-llm-judge-prompt', async (req, res) => {
  try {
    const body = formatPromptSchema.parse(req.body);

    const formattedText = await formatLLMJudgePrompt(body.text);

    res.json({
      text: formattedText,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request body', details: error.errors });
      return;
    }
    console.error('Format prompt error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Failed to format prompt',
      details: errorMessage,
      hasOpenAIKey: !!process.env.OPENAI_API_KEY 
    });
  }
});

export default router;

