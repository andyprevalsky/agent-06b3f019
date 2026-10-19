/**
 * Agent environment rows (agents/helpers/environment_context.py).
 *
 * [workflow posts USER row {environmentContext: true, hidden: true}]
 *   -> model-visible run-time state (date, own path, running agents)
 *   -> NEVER a user bubble: the trajectory filter drops it by this flag,
 *      even if a row ever arrives without `hidden`.
 */
import type { Message } from '@/lib/api';

export function isEnvironmentContextRow(message: Pick<Message, 'metadata'>): boolean {
  return message.metadata?.environmentContext === true;
}
