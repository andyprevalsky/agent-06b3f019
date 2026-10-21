/** Transcript/URL hints choose a lookup; the broker's owned lease authorizes viewing. */
import { getQueryParams } from '@/lib/url';
import type { Message } from '../../hooks';
import type { AgentBrowserTab } from './roseAppsState';
import { phoneActivityKey } from '../browser-status-bar/phone/phoneOverlayState';
import { phoneAttentionCandidate } from '../browser-status-bar/phone/phoneAttentionState';
export function phoneAppTarget(agentId: string, messages: Message[], tabs: AgentBrowserTab[]) {
  const tasks = new Set<string>();
  const query = getQueryParams();
  if (
    query.get('agent-id') === agentId &&
    query.get('attention-request-id') &&
    query.get('browser-id')
  )
    tasks.add(query.get('browser-id')!);
  for (const tab of tabs) if (tab.agentId === agentId) tasks.add(tab.taskId);
  for (const message of messages) {
    const meta = message.metadata;
    const id = typeof meta?.task_id === 'string' ? meta.task_id : meta?.subAgentId;
    if (typeof id === 'string' && (meta?.action_type === 'phone' || meta?.toolName === 'phone'))
      tasks.add(id);
    const request = meta?.requestUserAuthentication;
    if (request && typeof request === 'object') {
      const target = (request as Record<string, unknown>).target;
      if (
        target &&
        typeof target === 'object' &&
        (target as Record<string, unknown>).kind === 'iphone'
      ) {
        const taskId = (target as Record<string, unknown>).browserTaskId;
        if (typeof taskId === 'string') tasks.add(taskId);
      }
    }
  }
  const candidates = [...tasks].filter(
    (taskId) =>
      phoneActivityKey(messages, taskId) || phoneAttentionCandidate(taskId, agentId, messages),
  );
  return candidates.length === 1 ? candidates[0] : null;
}
