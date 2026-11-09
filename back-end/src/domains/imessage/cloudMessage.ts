import type { ImessageQueue } from './types';

/** These are transport outcomes; submitted/unknown never mean sent or delivered. */
export function cloudMessageStatus(row: ImessageQueue): string {
  if (row.sentAt) return 'sent';
  if (row.failedAt) return 'failed';
  if (row.dispatchedAt) return row.lastError !== null ? 'unknown' : 'submitted';
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'approved';
}
export function cloudMessageReceipt(row: ImessageQueue) {
  return {
    success: true,
    queue_id: row.id,
    provider: 'phone_harness',
    status: cloudMessageStatus(row),
    browser_task_id: row.phoneBrowserTaskId,
    sent_at: row.sentAt?.toISOString() ?? null,
  };
}
