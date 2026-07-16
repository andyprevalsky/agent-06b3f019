import { z } from 'zod';

export const notifySchema = z.object({
  user_id: z.string(),
  event_type: z.enum([
    'agent_started',
    'planner_message',
    'write_lock',
    'agentcard_setup',
    'completion',
    'cost_limit',
  ]),
  agent_id: z.string(),
  payload: z.record(z.any()).optional(),
});

export type NotifyInput = z.infer<typeof notifySchema>;
