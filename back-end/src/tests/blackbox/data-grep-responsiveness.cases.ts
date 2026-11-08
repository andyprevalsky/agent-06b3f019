/**
 * Grep's ReDoS guard must not stall the shared backend.
 *
 *   N concurrent POST /api/data/grep (pattern the analyzer cannot classify)
 *        │                      ┌─ before: recheck checkSync parks the main thread
 *        ▼                      │  for the whole 1 s deadline, one grep at a time
 *   checkPatternSafety ─────────┤
 *        │                      └─ after: recheck check runs off the event loop
 *        ▼
 *   GET /health on fresh connections must keep answering throughout
 *
 * The pattern is the one report-bug's fixture chats grepped when the shard-2
 * coverage backend froze for 6.7 s and dropped keep-alive sockets (fetch failed
 * in unrelated domains): docs/rca/cases/2026-11-08-grep-regex-safety-blocked-event-loop.md.
 * Registered by data-grep.blackbox.ts.
 */
import http from 'node:http';

import { BASE_URL, requestGrep } from './data-grep.helpers';

const UNCLASSIFIED_PATTERN = 'report-bug.*blackbox.*fixture|blackbox.*fixture|report-bug';
const CONCURRENT_GREPS = 8;
const PROBE_INTERVAL_MS = 100;
// One synchronous analysis alone blocks for its 1000 ms deadline; eight in a
// row block for seconds. A responsive loop answers /health in milliseconds.
const MAX_HEALTH_LATENCY_MS = 2000;

/** One /health round trip on its own connection, so a pooled socket cannot hide a stall. */
function probeHealth(): Promise<number> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}/health`, { agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(Date.now() - startedAt));
    });
    req.on('error', reject);
  });
}

export async function testConcurrentUnclassifiedGrepsKeepBackendResponsive(
  userId: string
): Promise<void> {
  const probes: Promise<number>[] = [];
  const timer = setInterval(() => probes.push(probeHealth()), PROBE_INTERVAL_MS);
  probes.push(probeHealth());
  let responses: { status: number; data: unknown }[];
  try {
    responses = await Promise.all(
      Array.from({ length: CONCURRENT_GREPS }, () =>
        requestGrep(userId, { pattern: UNCLASSIFIED_PATTERN, source: 'messages', '-i': true })
      )
    );
  } finally {
    clearInterval(timer);
  }
  const latencies = await Promise.all(probes);
  for (const { status, data } of responses) {
    if (status !== 200 && status !== 400) {
      throw new Error(`grep answered ${status}: ${JSON.stringify(data)}`);
    }
  }
  const worst = Math.max(...latencies);
  if (worst > MAX_HEALTH_LATENCY_MS) {
    throw new Error(
      `GET /health took ${worst} ms while ${CONCURRENT_GREPS} greps ran their ReDoS analysis ` +
        `(limit ${MAX_HEALTH_LATENCY_MS} ms over ${latencies.length} probes): the analysis blocked the event loop`
    );
  }
}
