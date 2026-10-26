/** Match only verified healthy agent-routing transport rows. */
import type { Message } from '../../hooks';
import { parsePinnedQuestion } from '../../hooks/codeAgentContract';

export function isRoutineAgentRouting(message: Message, knownHealthyNativeTool = false): boolean {
  const meta = message.metadata;
  if (!meta || message.role !== 'TOOL' || parsePinnedQuestion(meta)) return false;
  if (meta.error || meta.requestUserApproval || meta.isUserAttentionMessage) return false;
  if (meta.toolStatus !== 'IN_PROGRESS' && meta.toolStatus !== 'FINISHED') return false;
  if (meta.toolName === 'send_message_to_agent') return true;
  // Native transcript adapter emits Run + the command target. Match only the
  // standalone known transport, never arbitrary shell text mentioning it.
  return (
    knownHealthyNativeTool &&
    meta.toolName === 'Run' &&
    typeof meta.title === 'string' &&
    /^Run rose-agents send [\w-]+\s/.test(meta.title) &&
    !/[\n;&|`]/.test(meta.title)
  );
}
