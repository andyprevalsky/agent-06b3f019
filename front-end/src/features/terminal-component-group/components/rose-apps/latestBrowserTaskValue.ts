/** Hydration and realtime replay may append an older observation after a newer one. */
import type { Message } from '../../hooks';

export function latestBrowserTaskValue(
  messages: Message[],
  taskId: string,
  read: (metadata: NonNullable<Message['metadata']>) => string | null,
): string | null {
  let latest: string | null = null;
  let fallback: string | null = null;
  let latestTime = -Infinity;
  for (const message of messages) {
    if (message.metadata?.task_id !== taskId) continue;
    const value = read(message.metadata);
    if (value === null) continue;
    const time = Date.parse(message.timestamp);
    if (!Number.isFinite(time)) fallback = value;
    else if (time >= latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest ?? fallback;
}
