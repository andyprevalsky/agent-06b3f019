import { z } from 'zod';

export const generatePromptSchema = z.object({
  goal: z.string().min(1),
});

export type GeneratePromptBody = z.infer<typeof generatePromptSchema>;
