/** Task-local session: hidden -> abort/revoke; active -> one sequential reader and stable operation receipt. */
import type { PhoneBounds, PhoneInteraction, PhoneOperation } from '@/lib/api/iphone';

export interface Scope {
  taskId: string;
  notice: string;
  controller: AbortController;
  snapshot: PhoneInteraction | null;
  frame: string | null;
  bounds: PhoneBounds | null;
  boundsAt: number;
  action: boolean;
  polling: Promise<void> | null;
  operation: PhoneOperation | null;
  queued: boolean;
  bootstrapReads: number;
  blocked: boolean;
  stopped: boolean;
  trigger: string;
}
export interface View {
  taskId: string;
  notice: string;
  snapshot: PhoneInteraction | null;
  frame: string | null;
  bounds: PhoneBounds | null;
  busy: boolean;
  error: string;
  uncertain: boolean;
  queueTimedOut: boolean;
}
export const emptyView = (taskId: string): View => ({
  taskId,
  notice: '',
  snapshot: null,
  frame: null,
  bounds: null,
  busy: false,
  error: '',
  uncertain: false,
  queueTimedOut: false,
});
