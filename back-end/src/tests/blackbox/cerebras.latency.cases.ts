/**
 * Live Cerebras chat latency ratchet for the cerebras blackbox domain.
 *
 *   probe #1 ──2xx──> probe #2 ──2xx──> probe #3 ──> median(elapsedMs) < 5s ratchet
 *      │                 │                 │
 *      └─non-2xx─────────┴─────────────────┴──> stop sampling; the caller keeps its
 *                                               404 / quota / 2xx assertions
 *
 * Production never waits on one slow Cerebras request: chat hedges to OpenRouter
 * after DEFAULT_CEREBRAS_CHAT_HEDGE_MS and abandons Cerebras at its idle guard. The
 * ratchet guards the configured model + effort, so it judges the typical (median)
 * response, not one sample. A single provider/network tail (FLAKY d2ba002c: 23593ms
 * on a gate VM, rerun 173ms) no longer fails it; a model that is slow on most probes
 * still does, at the unchanged 5s bound.
 */
import assert from 'node:assert/strict';

export const CEREBRAS_CHAT_LATENCY_RATCHET_MS = 5_000;
export const CEREBRAS_CHAT_PROBE_SAMPLES = 3;

export interface CerebrasChatProbe {
  ok: boolean;
  status: number;
  text: string;
  elapsedMs: number;
  /** Cerebras `time_info.queue_time` (server-side queueing), when reported. */
  queueMs?: number;
  /** `x-request-id`, so a slow sample can be attributed with Cerebras. */
  requestId?: string;
}

/** Cerebras server-side queue time in ms from a chat completion body, when present. */
export function cerebrasQueueMs(text: string): number | undefined {
  try {
    const queue = (JSON.parse(text) as { time_info?: { queue_time?: unknown } }).time_info
      ?.queue_time;
    return typeof queue === 'number' ? Math.round(queue * 1_000) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes up to `samples` sequential probes, stopping at the first non-2xx so the
 * caller judges archived (404), quota and other failures exactly as before.
 */
export async function sampleCerebrasChatProbes(
  probeOnce: () => Promise<CerebrasChatProbe>,
  samples: number = CEREBRAS_CHAT_PROBE_SAMPLES
): Promise<CerebrasChatProbe[]> {
  const probes: CerebrasChatProbe[] = [];
  for (let index = 0; index < samples; index++) {
    const probe = await probeOnce();
    probes.push(probe);
    if (!probe.ok) break;
  }
  return probes;
}

export function medianElapsedMs(probes: CerebrasChatProbe[]): number {
  assert.ok(probes.length > 0, 'latency ratchet needs at least one probe');
  const sorted = probes.map((probe) => probe.elapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function describeProbes(probes: CerebrasChatProbe[]): string {
  return probes
    .map(
      (probe) =>
        `${probe.elapsedMs}ms(queue=${probe.queueMs ?? '?'}ms id=${probe.requestId ?? '?'})`
    )
    .join(', ');
}

export function assertChatLatencyRatchet(probes: CerebrasChatProbe[]): number {
  assert.equal(
    probes.length,
    CEREBRAS_CHAT_PROBE_SAMPLES,
    `latency ratchet needs ${CEREBRAS_CHAT_PROBE_SAMPLES} successful probes`
  );
  const median = medianElapsedMs(probes);
  assert.ok(
    median < CEREBRAS_CHAT_LATENCY_RATCHET_MS,
    `chat model probe must stay under the lifecycle ratchet (${median}ms median of ${describeProbes(probes)})`
  );
  return median;
}

function syntheticProbe(elapsedMs: number): CerebrasChatProbe {
  return { ok: true, status: 200, text: '{}', elapsedMs };
}

/**
 * Hermetic regression (no network): the ratchet tolerates one tail sample, still
 * fails a model that is slow on most probes, and stops sampling on a non-2xx.
 */
export async function assertLatencyRatchetJudgesTypicalResponse(): Promise<void> {
  // The d2ba002c tail: one 23593ms response among fast ones passes.
  assert.equal(assertChatLatencyRatchet([23_593, 150, 156].map(syntheticProbe)), 156);
  // Slow on most probes still fails at the unchanged bound.
  assert.throws(
    () => assertChatLatencyRatchet([6_000, 150, 5_000].map(syntheticProbe)),
    /chat model probe must stay under the lifecycle ratchet \(5000ms median/
  );
  // A partial sample set cannot pass the ratchet.
  assert.throws(() => assertChatLatencyRatchet([syntheticProbe(150)]), /3 successful probes/);
  // Sampling stops at the first non-2xx so the caller's 404/quota logic sees it.
  let calls = 0;
  const stopped = await sampleCerebrasChatProbes(async () => {
    calls += 1;
    return calls === 2
      ? { ok: false, status: 404, text: 'model_not_found', elapsedMs: 90 }
      : syntheticProbe(120);
  });
  assert.deepEqual(
    stopped.map((probe) => probe.status),
    [200, 404]
  );
  assert.equal(
    cerebrasQueueMs('{"time_info":{"queue_time":0.0004888,"total_time":0.015}}'),
    0,
    'queue_time is reported in seconds'
  );
  assert.equal(cerebrasQueueMs('{"time_info":{"queue_time":23.4}}'), 23_400);
  assert.equal(cerebrasQueueMs('not json'), undefined);
}
