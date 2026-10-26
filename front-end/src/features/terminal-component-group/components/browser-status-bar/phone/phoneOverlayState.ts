/** [task phone activity] -> one owned interaction read; unrelated tasks never start a reader. */
import type { Message } from '../../../hooks';
import type { PhoneBounds, PhoneLease } from '@/lib/api/iphone';

export function phoneActivityKey(messages: Message[], taskId: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const meta = message.metadata;
    if (
      (meta?.task_id === taskId || meta?.subAgentId === taskId) &&
      (meta.action_type === 'phone' || meta.toolName === 'phone')
    ) {
      return `${taskId}:${message.message_id}:${message.timestamp}:${String(meta.toolCallId ?? '')}`;
    }
  }
  return '';
}
export function phoneLeaseVisible(lease: PhoneLease | null | undefined): boolean {
  return lease?.status === 'ACTIVE' || lease?.status === 'WAITING';
}
export function readPointBounds(value: unknown): PhoneBounds | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>;
  if (
    !['x', 'y', 'w', 'h'].every((key) => typeof b[key] === 'number' && Number.isFinite(b[key])) ||
    Number(b.w) <= 0 ||
    Number(b.h) <= 0
  )
    return null;
  return { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) };
}
/** PNG dimensions describe letterboxing only; point extents/origin come exclusively from screen.bounds. */
export function phonePoint(
  image: HTMLImageElement,
  bounds: PhoneBounds,
  clientX: number,
  clientY: number,
) {
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const ratio =
    image.naturalWidth > 0 && image.naturalHeight > 0
      ? image.naturalWidth / image.naturalHeight
      : rect.width / rect.height;
  const width = Math.min(rect.width, rect.height * ratio);
  const height = Math.min(rect.height, rect.width / ratio);
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  const x = (clientX - left) / width,
    y = (clientY - top) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: bounds.x + x * bounds.w, y: bounds.y + y * bounds.h };
}
