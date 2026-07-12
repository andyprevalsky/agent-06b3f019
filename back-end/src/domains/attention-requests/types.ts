import { z } from 'zod';

// ---------------------------------------------------------------------------
// Gate — the standard "the user must do one thing to continue" object. It rides
// inside AttentionRequest.metadata.gate; `gateKey` is also lifted to a top-level
// column for dedup. See docs/plans/active/sms-onboarding-and-gates.md.
// ---------------------------------------------------------------------------

export const gateActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('link'),
    url: z.string(),
    expiresAt: z.string().optional(),
  }),
  z.object({
    kind: z.literal('reply'),
    tokens: z.array(z.string()),
    paymentCard: z.record(z.any()).optional(),
  }),
]);

export const gateSchema = z.object({
  gateKey: z.string().min(1),
  type: z.enum(['source_connect', 'subscription', 'kyc', 'approval']),
  status: z.enum(['PENDING', 'RESOLVED', 'EXPIRED', 'REJECTED']),
  severity: z.enum(['blocking', 'advisory']),
  presentation: z.object({
    title: z.string(),
    reason: z.string(),
    cta: z.string(),
  }),
  action: gateActionSchema,
  detection: z.object({
    method: z.enum(['oauth_callback', 'stripe_webhook', 'kyc_webhook', 'reply', 'probe']),
    probeKey: z.string(),
  }),
  context: z.object({ sourceKey: z.string().optional() }).optional(),
});

export type Gate = z.infer<typeof gateSchema>;

export const createAttentionRequestSchema = z.object({
  userId: z.string(),
  agentId: z.string(),
  workflowId: z.string(),
  question: z.string().min(1),
  imageUrl: z.string().url().optional(),
  metadata: z.record(z.any()).optional(),
  // Dedup identity. When present, a pending request with the same
  // (userId, gateKey) is reused instead of creating a duplicate.
  gateKey: z.string().min(1).optional(),
});

export type CreateAttentionRequestInput = z.infer<typeof createAttentionRequestSchema>;

export const respondSchema = z.object({
  response: z.string().min(1),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
});

export type RespondInput = z.infer<typeof respondSchema>;
