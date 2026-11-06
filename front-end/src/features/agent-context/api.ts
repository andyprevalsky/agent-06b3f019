import {
  benchmarkAgentPreviewEnabled,
  getAgent,
  getAgentMessage,
  getBenchmarkAgentPreview,
  getBenchmarkSharedAgent,
  postMessage as postMessageAPI,
} from '@/lib/api';
import { isBenchmarkSharedView } from '@/lib/benchmarkShare';

export { benchmarkAgentPreviewEnabled };

/**
 * Agent-detail read registry (selected-agent reads only).
 *
 * Opening a trajectory starts the selection's GET /agents/:id while the
 * realtime join is still pending, and the disconnected backfill's 300ms poll
 * would otherwise start an identical full-trajectory read beside it — or right
 * after it — (another download, JSON parse and message merge of the same
 * rows). The poll consults this registry: it skips a tick while a recent read
 * of the same agent is in flight, or when another read of it succeeded less
 * than one fast tick ago; that read's owner applied the rows, and the next tick
 * polls as usual if the channel is still down. In-flight reads older than the
 * caller's bound never suppress anything, so a hung request cannot disable the
 * fallback.
 *
 * Scale: one entry per in-flight read plus ONE last-success record; O(1) work
 * per read and per poll tick, independent of how many agents a user owns.
 */
const inFlightDetailReads = new Map<string, Map<symbol, number>>();
let lastDetailSuccess: { agentId: string; at: number } | null = null;

function beginAgentDetailRead(agentId: string): (succeeded: boolean) => void {
  const token = Symbol(agentId);
  let reads = inFlightDetailReads.get(agentId);
  if (!reads) {
    reads = new Map();
    inFlightDetailReads.set(agentId, reads);
  }
  reads.set(token, Date.now());
  return (succeeded) => {
    const current = inFlightDetailReads.get(agentId);
    current?.delete(token);
    if (current?.size === 0) inFlightDetailReads.delete(agentId);
    if (succeeded) lastDetailSuccess = { agentId, at: Date.now() };
  };
}

/** True while a read of this agent started less than `maxAgeMs` ago is in flight. */
export function hasRecentAgentDetailRead(
  agentId: string,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  const reads = inFlightDetailReads.get(agentId);
  if (!reads) return false;
  for (const startedAt of reads.values()) {
    if (now - startedAt < maxAgeMs) return true;
  }
  return false;
}

/** When the latest successful detail read of this agent settled, if it was the latest read at all. */
export function agentDetailSucceededAt(agentId: string): number | null {
  return lastDetailSuccess?.agentId === agentId ? lastDetailSuccess.at : null;
}

/** Fetch agent detail and messages by agent ID (tracked in the read registry above). */
export async function fetchAgentDetail(agentId: string, signal?: AbortSignal) {
  const settle = beginAgentDetailRead(agentId);
  let succeeded = false;
  try {
    const detail = await readAgentDetail(agentId, signal);
    succeeded = true;
    return detail;
  } finally {
    settle(succeeded);
  }
}

async function readAgentDetail(agentId: string, signal?: AbortSignal) {
  if (isBenchmarkSharedView()) return getBenchmarkSharedAgent(agentId, signal);
  try {
    return await getAgent(agentId, undefined, signal);
  } catch (error) {
    if (signal?.aborted || !benchmarkAgentPreviewEnabled()) {
      throw error;
    }
    return getBenchmarkAgentPreview(agentId, signal);
  }
}

/** Post a user message to the given agent. */
export async function postAgentMessage(agentId: string, text: string) {
  return postMessageAPI(agentId, text);
}

/** Fetch one committed message of the selected agent by ID. */
export async function fetchAgentMessage(agentId: string, messageId: string, signal?: AbortSignal) {
  return getAgentMessage(agentId, messageId, signal);
}
