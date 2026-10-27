/** Display-only task name, joined through the browser's original spawn call. */
import type { Message } from '../../hooks';
import { BROWSER_INIT_ACTION_TYPES } from '@/lib/backendToolNames';
import { agentPathShortName } from '../../hooks/backgroundSpawns';
import { latestBrowserTaskValue } from './latestBrowserTaskValue';

export function browserTaskLabel(messages: Message[], taskId: string): string {
  const names = new Map<string, string>();
  for (const message of messages) {
    const { toolCallId, backgroundPath } = message.metadata ?? {};
    const name = agentPathShortName(
      typeof backgroundPath === 'string' ? backgroundPath : undefined,
    );
    if (typeof toolCallId === 'string' && name !== null) names.set(toolCallId, name);
  }
  const name = latestBrowserTaskValue(messages, taskId, (metadata) =>
    BROWSER_INIT_ACTION_TYPES.has(metadata.action_type ?? '') &&
    typeof metadata.toolCallId === 'string'
      ? (names.get(metadata.toolCallId) ?? null)
      : null,
  );
  if (name === null) return 'Browser task';
  const label = name.replace(/[_-]+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}
