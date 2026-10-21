/** Only an authoritative decision model from this exact task can label its composer. */
import type { Message } from '../../hooks';

export function latestBrowserActualModel(messages: Message[], taskId: string): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const metadata = messages[index].metadata;
    if (metadata?.task_id !== taskId) continue;
    const auxiliary = metadata.auxiliary;
    if (typeof auxiliary !== 'object' || auxiliary === null) continue;
    const model = (auxiliary as Record<string, unknown>).actual_model;
    if (typeof model === 'string' && model.trim()) return model.trim();
  }
  return null;
}
