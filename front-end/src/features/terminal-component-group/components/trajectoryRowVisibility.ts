/** Rows whose content is rendered elsewhere or whose normal bubble renders nothing. */
import type { Message } from '../hooks';
import { parseAgentToAgentMessage, parsePinnedQuestion } from '../hooks/codeAgentContract';

export function isHiddenTrajectoryRow(message: Message): boolean {
  const metadata = message.metadata;
  if (parsePinnedQuestion(metadata)) return true;
  if (message.file_pointer || metadata?.inlineView) return false;
  if (message.role === 'ASSISTANT') return !message.text.trim();
  if (message.role === 'USER') return !message.text.trim() && !parseAgentToAgentMessage(message);
  if (message.role !== 'TOOL') return false;
  // Agent-specific routes take precedence over generic approval/gate placeholders.
  const tool = metadata?.toolName;
  // The display itself is the row the user sees ("Displayed for the user" adds
  // nothing); a failed or rejected display keeps its error row.
  if (tool === 'display')
    return !metadata?.error && !/failed|error/i.test(String(metadata?.toolStatus ?? ''));
  if (
    [
      'spawn_general_purpose_agent',
      'spawn_general_purpose_agent_for_each',
      'spawn_sub_agent',
      'wait_for',
    ].includes(String(tool)) ||
    (tool === 'spawn_agent' && metadata?.agentType === 'explore') ||
    metadata?.requestUserSignup
  )
    return false;
  const approval = metadata?.requestUserApproval as { toolApproval?: unknown } | undefined;
  return Boolean(approval?.toolApproval || metadata?.gate);
}
