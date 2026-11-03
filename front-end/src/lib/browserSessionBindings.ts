/**
 * Latest known provider-session binding per browser task.
 *
 * WRITERS                                   READERS
 * BROWSER_SESSION on agent:<id> ----+
 *                                   +--> bindings[taskId] --> useBrowserSessionBinding
 * GET .../task/:id/live-view -------+      (newest asOf wins)
 *
 * The backend rebinds a task's row before it releases the old provider
 * session and broadcasts the new binding; the transcript's browser_url only
 * catches up when the worker next posts. Both writers carry the server's
 * `asOf`, so a GET that read the row before a rebind cannot overwrite the
 * broadcast for that rebind.
 */

import type { BrowserSessionBindingPayload } from './realtime-types';
import { createTaskSnapshotStore } from './taskSnapshotStore';

export type BrowserSessionBinding = Omit<BrowserSessionBindingPayload, 'agentId'>;

const bindings = createTaskSnapshotStore<BrowserSessionBinding>(
  (current, next) => current.asOf <= next.asOf,
);

export function publishBrowserSessionBinding(binding: BrowserSessionBinding): void {
  bindings.publish(binding.taskId, {
    taskId: binding.taskId,
    sessionId: binding.sessionId,
    debugUrl: binding.debugUrl,
    status: binding.status,
    live: binding.live,
    asOf: binding.asOf,
  });
}

export function getBrowserSessionBinding(taskId: string): BrowserSessionBinding | null {
  return bindings.get(taskId);
}

export function subscribeBrowserSessionBinding(taskId: string, listener: () => void): () => void {
  return bindings.subscribe(taskId, listener);
}

/** Test isolation: forget every binding (listeners stay attached). */
export function clearBrowserSessionBindings(): void {
  bindings.clear();
}
