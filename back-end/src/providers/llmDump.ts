/**
 * Development context dumps and encrypted private production archives for backend Rose calls.
 *
 * Mirrors agents/helpers/observability.py:
 *   .llm-dumps/<agent_id>/<timestamp>-<span_id>-<call_site>.json
 *
 * Production is Fly (FLY_APP_NAME, as in the Python helper) or Render, which sets
 * NODE_ENV=production but not FLY_APP_NAME. Dump failures are best-effort and
 * never affect the LLM call.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger';
import { currentTraceContext } from './tracing';
import { archiveEnabled, encryptArtifact } from './traceArchive';

const log = createLogger('LlmDump');

function isProduction(): boolean {
  return process.env.FLY_APP_NAME !== undefined || process.env.NODE_ENV === 'production';
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DUMP_ROOT = path.join(REPO_ROOT, '.llm-dumps');

function safeFilenameSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
  return cleaned || 'unbound';
}

function safeJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, child) => {
      if (typeof child === 'bigint') return child.toString();
      if (child instanceof Error) {
        return { name: child.name, message: child.message, stack: child.stack };
      }
      return child;
    },
    2
  );
}

export interface LlmDumpPayload {
  call_site: string;
  agent_id?: string | null;
  span_id?: string | null;
  model?: string | null;
  message_count: number;
  messages: unknown[];
  config?: Record<string, unknown>;
  response_format?: unknown;
  tools?: unknown[];
  extra?: Record<string, unknown>;
}

type ArchiveCall = {
  agentId: string;
  dumpId: string;
  rootId: string | null;
  tail: Promise<void>;
  failed: boolean;
  updateSequence: number;
  lastCreatedAtMs: number | null;
};
const archiveCalls = new Map<string, ArchiveCall>();
const archiveCallsByAgent = new Map<string, Map<string, ArchiveCall>>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function originalRoot(agentId: string): Promise<string> {
  const { prisma } = await import('./database');
  const { findGraphRootId } = await import('./agentGraph/tree');
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { userId: true },
  });
  if (!agent?.userId) throw new Error('Missing original dump owner');
  const rootId = await findGraphRootId(agentId, agent.userId);
  if (!rootId) throw new Error('Missing original dump root');
  const root = await prisma.agent.findFirst({
    where: { id: rootId, userId: agent.userId },
    select: { parentAgentId: true },
  });
  if (!root || root.parentAgentId !== null) throw new Error('Incomplete original dump ancestry');
  return rootId;
}

async function storePrivate(
  call: ArchiveCall,
  objectPath: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!call.rootId) throw new Error('Missing bound dump root');
  const encrypted = encryptArtifact(
    objectPath,
    Buffer.from(safeJson(payload)),
    'application/json',
    true
  );
  if (!encrypted) throw new Error('Private dump encryption unavailable');
  if (call.lastCreatedAtMs !== null && encrypted.metadata.created_at_ms < call.lastCreatedAtMs) {
    throw new Error('Private archive clock regressed');
  }
  call.lastCreatedAtMs = encrypted.metadata.created_at_ms;
  // Reuse envelope validation, immutable storage and late-finalization manifest reconciliation.
  const { storeWorkerArtifact } = await import('./traceArchiveLifecycle');
  await storeWorkerArtifact({
    rootAgentId: call.rootId,
    path: objectPath,
    ciphertextB64: encrypted.ciphertext.toString('base64'),
    metadata: encrypted.metadata,
  });
}

function retainFailure(call: ArchiveCall): void {
  // Attach a rejection handler immediately; the original tail still rejects at the root drain.
  void call.tail.catch(() => {
    call.failed = true;
    log.warn('llm.archive.failed', {
      agent_id: call.agentId,
      dump_id: call.dumpId,
    });
  });
}

function privateDump(payload: LlmDumpPayload): string | null {
  const agentId = payload.agent_id || currentTraceContext()?.agent_id;
  if (!archiveEnabled() || !agentId || !uuid.test(agentId)) return null;
  const dumpId = randomUUID().replace(/-/g, '');
  const handle = `private-llm:${dumpId}`;
  const call: ArchiveCall = {
    agentId,
    dumpId,
    rootId: null,
    tail: Promise.resolve(),
    failed: false,
    updateSequence: 0,
    lastCreatedAtMs: null,
  };
  // Register before any async owner lookup so finalization can drain this agent's pending binding too.
  archiveCalls.set(handle, call);
  let agentCalls = archiveCallsByAgent.get(agentId);
  if (!agentCalls) {
    agentCalls = new Map();
    archiveCallsByAgent.set(agentId, agentCalls);
  }
  agentCalls.set(handle, call);
  let captured: Record<string, unknown>;
  try {
    captured = JSON.parse(
      safeJson({
        ...payload,
        span_id:
          payload.span_id ||
          currentTraceContext()?.span_id ||
          randomUUID().replace(/-/g, '').slice(0, 12),
        recorded_at_ms: Date.now(),
      })
    );
  } catch {
    call.tail = Promise.reject(new Error('Private LLM context serialization failed'));
    retainFailure(call);
    return handle;
  }
  call.tail = originalRoot(agentId).then(async (rootId) => {
    call.rootId = rootId;
    await storePrivate(call, `llm/${dumpId}.json.gz.enc`, {
      ...captured,
      agent_id: agentId,
      root_agent_id: rootId,
      dump_id: dumpId,
    });
  });
  retainFailure(call);
  return handle;
}

/** Join only calls belonging to the original fixture tree, before its archive ACK. */
export async function drainLlmDumpArchives(
  rootId: string,
  agentIds: readonly string[]
): Promise<void> {
  const owned = new Set([rootId, ...agentIds]);
  const snapshot = (): [string, ArchiveCall][] => {
    const entries: [string, ArchiveCall][] = [];
    for (const agentId of owned) {
      const indexed = archiveCallsByAgent.get(agentId);
      if (indexed) for (const entry of indexed) entries.push(entry);
    }
    return entries;
  };
  for (;;) {
    const entries = snapshot();
    const calls = entries.map(([, call]) => call);
    const tails = calls.map((call) => call.tail);
    const settled = await Promise.allSettled(tails);
    if (
      settled.some((result) => result.status === 'rejected') ||
      calls.some((call) => call.failed || call.rootId !== rootId)
    ) {
      throw new Error(`Required private LLM archive failed for ${rootId}`);
    }
    const latest = snapshot();
    if (
      latest.length === entries.length &&
      latest.every(
        ([handle, call], index) =>
          handle === entries[index][0] && call === calls[index] && call.tail === tails[index]
      )
    ) {
      for (const [handle, call] of entries) {
        archiveCalls.delete(handle);
        const indexed = archiveCallsByAgent.get(call.agentId);
        indexed?.delete(handle);
        if (indexed?.size === 0) archiveCallsByAgent.delete(call.agentId);
      }
      return;
    }
  }
}

export function dumpLlmContext(payload: LlmDumpPayload): string | null {
  if (isProduction()) return privateDump(payload);

  try {
    const trace = currentTraceContext();
    const spanId = payload.span_id || trace?.span_id || randomUUID().replace(/-/g, '').slice(0, 12);
    const agentId = payload.agent_id || trace?.agent_id || 'unbound';
    const agentDir = path.join(DUMP_ROOT, safeFilenameSegment(agentId));
    fs.mkdirSync(agentDir, { recursive: true });

    const filename = `${Date.now()}-${safeFilenameSegment(spanId)}-${safeFilenameSegment(
      payload.call_site
    )}.json`;
    const dumpPath = path.join(agentDir, filename);
    const fullPayload = {
      ...payload,
      agent_id: agentId,
      span_id: spanId,
    };
    fs.writeFileSync(dumpPath, safeJson(fullPayload), 'utf8');

    const totalChars = payload.messages.reduce<number>((sum, message) => {
      if (message && typeof message === 'object' && 'content' in message) {
        return sum + String((message as { content?: unknown }).content ?? '').length;
      }
      return sum + String(message ?? '').length;
    }, 0);
    log.info('llm.context.dumped', {
      path: dumpPath,
      call_site: payload.call_site,
      agent_id: agentId,
      span_id: spanId,
      model: payload.model,
      message_count: payload.message_count,
      total_chars: totalChars,
    });
    return dumpPath;
  } catch (error) {
    log.warn('llm.context.dump_failed', {
      call_site: payload.call_site,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
    return null;
  }
}

export function updateLlmDump(dumpPath: string | null, patch: Record<string, unknown>): void {
  if (dumpPath === null) return;
  const call = archiveCalls.get(dumpPath);
  if (call) {
    let captured: Record<string, unknown>;
    const sequence = ++call.updateSequence;
    try {
      if (!Number.isSafeInteger(sequence)) throw new Error('Private update sequence exhausted');
      captured = JSON.parse(safeJson(patch));
    } catch {
      call.tail = call.tail.then(() => {
        throw new Error('Private LLM update serialization failed');
      });
      retainFailure(call);
      return;
    }
    // Canonical readers sort equal-time updates by path; UUID entropy cannot define their order.
    const ordinal = String(sequence).padStart(16, '0');
    call.tail = call.tail.then(() =>
      storePrivate(
        call,
        `llm-updates/${call.dumpId}-${ordinal}-${randomUUID().replace(/-/g, '')}.json.gz.enc`,
        {
          ...captured,
          root_agent_id: call.rootId,
          agent_id: call.agentId,
          dump_id: call.dumpId,
        }
      )
    );
    retainFailure(call);
    return;
  }
  if (isProduction()) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(dumpPath, 'utf8')) as Record<string, unknown>;
    const merged = { ...parsed, ...patch };
    if (parsed.config || patch.config) {
      merged.config = {
        ...((parsed.config as Record<string, unknown> | undefined) ?? {}),
        ...((patch.config as Record<string, unknown> | undefined) ?? {}),
      };
    }
    if (parsed.extra || patch.extra) {
      merged.extra = {
        ...((parsed.extra as Record<string, unknown> | undefined) ?? {}),
        ...((patch.extra as Record<string, unknown> | undefined) ?? {}),
      };
    }
    fs.writeFileSync(dumpPath, safeJson(merged), 'utf8');
  } catch (error) {
    log.warn('llm.context.dump_update_failed', {
      path: dumpPath,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
  }
}
