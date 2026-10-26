/**
 * Latest CPU / memory / disk sample per code-agent task (item 29).
 *
 * WRITER                                        READERS
 * CODE_RESOURCES on agent:<id> ──► samples[taskId] ──► useCodeResources(taskId)
 *   (backend keepalive, ~every 120 s           (newest sampled_at wins)   chip + view header
 *    per running E2B session)
 *
 * Clients never fetch or poll for this: they render what the agent channel
 * delivered. Not persisted server-side, so after a reload the indicator
 * returns with the next keepalive sample. A null resource was not measured.
 */

import { useCallback, useSyncExternalStore } from 'react';

export interface ByteUsage {
  used_bytes: number;
  total_bytes: number;
}

export interface CodeResourceSample {
  /** ISO-8601 time the sandbox was measured. */
  sampled_at: string;
  cpu: { used_pct: number; cores: number } | null;
  memory: ByteUsage | null;
  disk: ByteUsage | null;
}

/** A resource bar turns to the warning colour from this usage. */
export const RESOURCE_WARNING_PCT = 80;

export function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function bytes(value: unknown): ByteUsage | null {
  const r = rec(value);
  if (!r || !num(r.used_bytes) || !num(r.total_bytes) || r.total_bytes <= 0 || r.used_bytes < 0) {
    return null;
  }
  return { used_bytes: Math.min(r.used_bytes, r.total_bytes), total_bytes: r.total_bytes };
}

export function parseCodeResourceSample(value: unknown): CodeResourceSample | null {
  const r = rec(value);
  if (!r || typeof r.sampled_at !== 'string' || Number.isNaN(Date.parse(r.sampled_at))) return null;
  const cpuRec = rec(r.cpu);
  const cpu =
    cpuRec && num(cpuRec.used_pct) && num(cpuRec.cores) && cpuRec.cores > 0
      ? { used_pct: Math.min(100, Math.max(0, cpuRec.used_pct)), cores: cpuRec.cores }
      : null;
  const memory = bytes(r.memory);
  const disk = bytes(r.disk);
  if (!cpu && !memory && !disk) return null;
  return { sampled_at: r.sampled_at, cpu, memory, disk };
}

/** CODE_RESOURCES record: {agentId, taskId, resources}. */
export function parseCodeResourcesEvent(
  record: unknown,
): { taskId: string; resources: CodeResourceSample } | null {
  const r = rec(record);
  if (!r || typeof r.taskId !== 'string' || r.taskId === '') return null;
  const resources = parseCodeResourceSample(r.resources);
  return resources ? { taskId: r.taskId, resources } : null;
}

const samples = new Map<string, CodeResourceSample>();
const listeners = new Map<string, Set<() => void>>();

export function publishCodeResources(taskId: string, sample: CodeResourceSample): void {
  const current = samples.get(taskId);
  if (current && Date.parse(current.sampled_at) >= Date.parse(sample.sampled_at)) return;
  samples.set(taskId, sample);
  listeners.get(taskId)?.forEach((listener) => listener());
}

export function getCodeResources(taskId: string): CodeResourceSample | null {
  return samples.get(taskId) ?? null;
}

function subscribe(taskId: string, listener: () => void): () => void {
  let set = listeners.get(taskId);
  if (!set) {
    set = new Set();
    listeners.set(taskId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(taskId);
  };
}

export function useCodeResources(taskId: string): CodeResourceSample | null {
  const subscribeTask = useCallback(
    (listener: () => void) => subscribe(taskId, listener),
    [taskId],
  );
  const read = useCallback(() => getCodeResources(taskId), [taskId]);
  return useSyncExternalStore(subscribeTask, read, read);
}

/** Test isolation: forget every sample (listeners stay attached). */
export function clearCodeResources(): void {
  const taskIds = [...samples.keys()];
  samples.clear();
  taskIds.forEach((taskId) => listeners.get(taskId)?.forEach((listener) => listener()));
}

// ── display ──

const GIB = 1024 ** 3;

/** "16", "103" (whole GiB from 10), "4.9" below 10. */
export function formatGiB(byteCount: number): string {
  const gib = byteCount / GIB;
  if (gib >= 10) return String(Math.round(gib));
  return String(Math.round(gib * 10) / 10);
}

export function usagePct(usage: ByteUsage): number {
  return Math.round((usage.used_bytes / usage.total_bytes) * 100);
}

/** "11:02:15 AM" in the viewer's own time zone (Intl default zone). */
export function formatSampleTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
}
