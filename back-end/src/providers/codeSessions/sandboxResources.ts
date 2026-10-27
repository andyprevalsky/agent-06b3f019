/**
 * Item 29: the latest CPU / memory / disk sample of a code agent's E2B sandbox,
 * shown on its chip and in its code-agent view header.
 *
 *   attached code-agent activity ── keepalive (CODE_SESSION_KEEPALIVE_INTERVAL_S,
 *   120 s, per running session)
 *     └─ keepAliveCodeTask ── sampleSandboxResources(sandboxId)
 *          Sandbox.getMetrics(sandboxId, {start: now − 5 min}) → newest sample
 *          ├─ keepalive response `resources` (present only when sampled)
 *          └─ CODE_RESOURCES {taskId, resources} on agent:<agentId>
 *                └─ FE lib/codeResources store → chip + view header (no fetch)
 *
 * E2B reports total CPU %, core count, memory used/total and disk used/total;
 * it has no app/system CPU split, so none is published. A Mac (local) session
 * has no sandbox and therefore no sample. A failed or empty read publishes
 * nothing: the UI keeps the last sample with its time, or shows nothing.
 * Not persisted: the client keeps the latest sample it received; after a
 * reload the next keepalive refills it.
 *
 * 10k agents: one bounded E2B read (≤ 5 min of samples, 5 s request timeout)
 * per running E2B session per keepalive interval, plus one broadcast on that
 * agent's own channel. No shared row, counter, poll or per-client E2B call.
 */
import { Sandbox, type SandboxMetrics } from 'e2b';
import { broadcastCodeResources } from '../chat/supabaseBroadcast';
import { createLogger } from '../logger';

const log = createLogger('CodeSandboxResources');

/** How far back one read looks for the newest sample (E2B samples every few seconds). */
export const RESOURCE_SAMPLE_WINDOW_MS = 5 * 60 * 1000;
const RESOURCE_REQUEST_TIMEOUT_MS = 5000;

export interface ByteUsage {
  used_bytes: number;
  total_bytes: number;
}

/** Wire shape (keepalive response + CODE_RESOURCES payload). A null resource is unavailable. */
export interface CodeResourceSample {
  /** ISO-8601 time E2B took the sample. */
  sampled_at: string;
  cpu: { used_pct: number; cores: number } | null;
  memory: ByteUsage | null;
  disk: ByteUsage | null;
}

export type MetricsReader = (sandboxId: string, start: Date) => Promise<SandboxMetrics[]>;

const readE2bMetrics: MetricsReader = (sandboxId, start) =>
  Sandbox.getMetrics(sandboxId, {
    apiKey: process.env.E2B_API_KEY,
    start,
    requestTimeoutMs: RESOURCE_REQUEST_TIMEOUT_MS,
  });

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function bytes(used: unknown, total: unknown): ByteUsage | null {
  if (!finite(used) || !finite(total) || total <= 0 || used < 0) return null;
  return { used_bytes: Math.min(used, total), total_bytes: total };
}

function timeOf(metric: SandboxMetrics): number {
  const at = metric.timestamp instanceof Date ? metric.timestamp : new Date(metric.timestamp);
  return at.getTime();
}

/** One E2B metrics row → wire sample; null when it measures nothing usable. */
export function toResourceSample(metric: SandboxMetrics): CodeResourceSample | null {
  const at = timeOf(metric);
  if (!Number.isFinite(at)) return null;
  const cpu =
    finite(metric.cpuUsedPct) && finite(metric.cpuCount) && metric.cpuCount > 0
      ? { used_pct: Math.min(100, Math.max(0, metric.cpuUsedPct)), cores: metric.cpuCount }
      : null;
  const memory = bytes(metric.memUsed, metric.memTotal);
  const disk = bytes(metric.diskUsed, metric.diskTotal);
  if (cpu === null && memory === null && disk === null) return null;
  return { sampled_at: new Date(at).toISOString(), cpu, memory, disk };
}

/** Newest usable sample of a sandbox, or null (no samples yet, or the read failed). */
export async function sampleSandboxResources(
  sandboxId: string,
  read: MetricsReader = readE2bMetrics,
  now: Date = new Date()
): Promise<CodeResourceSample | null> {
  try {
    const metrics = await read(sandboxId, new Date(now.getTime() - RESOURCE_SAMPLE_WINDOW_MS));
    const newest = [...metrics].sort((a, b) => timeOf(b) - timeOf(a));
    for (const metric of newest) {
      const sample = toResourceSample(metric);
      if (sample !== null) return sample;
    }
    return null;
  } catch (error) {
    log.warn('Sandbox metrics read failed; no resource sample this keepalive', {
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export interface CodeResourceDeps {
  sample: (sandboxId: string) => Promise<CodeResourceSample | null>;
  publish: (agentId: string, taskId: string, sample: CodeResourceSample) => Promise<void>;
}

export const codeResourceDeps: CodeResourceDeps = {
  sample: (sandboxId) => sampleSandboxResources(sandboxId),
  publish: broadcastCodeResources,
};

/** Keepalive callers that measure nothing (tests of other keepalive duties). */
export const NO_CODE_RESOURCES: CodeResourceDeps = {
  sample: async () => null,
  publish: async () => undefined,
};
