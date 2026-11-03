/**
 * Agent-to-agent message schemas (same agent tree only).
 */

import { z } from 'zod';
import { agentAddressSchema } from './typesAgentTree';

// ---------------------------------------------------------------------------
// Agent-to-agent messages (same agent tree only)
// ---------------------------------------------------------------------------

export const AGENT_MESSAGE_MAX_CHARS = 20_000;
export const agentMessageSchema = z.object({
  from_agent_id: z.string().uuid(),
  message: z
    .string()
    .max(AGENT_MESSAGE_MAX_CHARS)
    .refine((text) => text.trim().length > 0, 'message must not be blank'),
  idempotency_key: z.string().min(1).max(200),
  recipient_task_id: z.string().min(1).max(200).optional(),
  // Resuming a paused browser/code task: continue its conversation or start fresh.
  continue_conversation: z.boolean().optional(),
});
export const agentInboxQuerySchema = z.object({
  task_id: z.string().min(1).max(200),
  since: z.coerce.date().optional(),
});
// POST /:sender/send-agent-message: like agentMessageSchema, addressed by `to`.
export const agentAddressMessageSchema = z.object({
  to: agentAddressSchema,
  message: z
    .string()
    .max(AGENT_MESSAGE_MAX_CHARS)
    .refine((text) => text.trim().length > 0, 'message must not be blank'),
  idempotency_key: z.string().min(1).max(200),
  continue_conversation: z.boolean().optional(),
});
export type AgentAddressMessageBody = z.infer<typeof agentAddressMessageSchema>;
export type AgentMessageBody = z.infer<typeof agentMessageSchema>;
export type AgentInboxQuery = z.infer<typeof agentInboxQuerySchema>;
