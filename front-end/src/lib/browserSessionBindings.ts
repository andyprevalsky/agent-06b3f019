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

export type BrowserSessionBinding = Omit<BrowserSessionBindingPayload, 'agentId'>;

const bindings = new Map<string, BrowserSessionBinding>();
const listeners = new Map<string, Set<() => void>>();

export function publishBrowserSessionBinding(binding: BrowserSessionBinding): void {
  const current = bindings.get(binding.taskId);
  if (current !== undefined && current.asOf > binding.asOf) return;
  bindings.set(binding.taskId, {
    taskId: binding.taskId,
    sessionId: binding.sessionId,
    debugUrl: binding.debugUrl,
    status: binding.status,
    live: binding.live,
    asOf: binding.asOf,
  });
  listeners.get(binding.taskId)?.forEach((listener) => listener());
}

export function getBrowserSessionBinding(taskId: string): BrowserSessionBinding | null {
  return bindings.get(taskId) ?? null;
}

export function subscribeBrowserSessionBinding(taskId: string, listener: () => void): () => void {
  let taskListeners = listeners.get(taskId);
  if (taskListeners === undefined) {
    taskListeners = new Set();
    listeners.set(taskId, taskListeners);
  }
  taskListeners.add(listener);
  return () => {
    taskListeners.delete(listener);
    if (taskListeners.size === 0) listeners.delete(taskId);
  };
}

/** Test isolation: forget every binding (listeners stay attached). */
export function clearBrowserSessionBindings(): void {
  const taskIds = [...bindings.keys()];
  bindings.clear();
  taskIds.forEach((taskId) => listeners.get(taskId)?.forEach((listener) => listener()));
}
