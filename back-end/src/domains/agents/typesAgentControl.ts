/**
 * Request schemas for agent-to-agent control routes (kill_agent).
 * Re-exported by types.ts.
 */

import { z } from 'zod';
import { agentAddressSchema } from './typesAgentTree';

// POST /:sender/kill-agent: kill a descendant (and its subtree) or a descendant's task.
export const agentKillSchema = z.object({
  to: agentAddressSchema,
  idempotency_key: z.string().min(1).max(200),
});
export type AgentKillBody = z.infer<typeof agentKillSchema>;
