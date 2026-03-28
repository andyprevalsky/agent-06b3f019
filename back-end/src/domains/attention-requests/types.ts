import { z } from 'zod';

export const createAttentionRequestSchema = z.object({
  userId: z.string(),
  agentId: z.string(),
  workflowId: z.string(),
  question: z.string().min(1),
  imageUrl: z.string().url().optional(),
  metadata: z.record(z.any()).optional(),
});

export type CreateAttentionRequestInput = z.infer<typeof createAttentionRequestSchema>;

export const respondSchema = z.object({
  response: z.string().min(1),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
});

export type RespondInput = z.infer<typeof respondSchema>;
