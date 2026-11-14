/**
 * LLM call capture for backend Rose calls.
 *
 * Two outputs per call:
 *   - DEV-only plaintext dump, mirroring agents/helpers/observability.py:
 *       .llm-dumps/<agent_id>/<timestamp>-<span_id>-<call_site>.json
 *     Production is Fly (FLY_APP_NAME, as in the Python helper) or Render, which
 *     sets NODE_ENV=production but not FLY_APP_NAME.
 *   - Encrypted archive records in the ROOT agent's bundle (llmArchiveRecord.ts,
 *     contract shared/llm-archive-record/record.schema.json v2):
 *
 *       call start ──► llm/<dump_id>          (start record: inputs; crash-safe)
 *       stream end ──► llm-updates/<dump_id>-<ms>-<call_site>  (final record:
 *                      output, usage, reasoning blocks, losing race attempts)
 *
 *   Root binding: an explicit root_agent_id is used as given. An archive_scope
 *   (agent/user ids from memory) is resolved to its tree root INSIDE the
 *   background archive task; nothing waits on that lookup before the model call:
 *
 *       startLlmCapture ─(sync)─► return          model call proceeds immediately
 *            └─ background: archiveBindingFor(scope) ─► start record
 *       finishLlmCapture ─(sync)─► return
 *            └─ background: same resolution ─► final record
 *
 * Dump/archive failures never affect the LLM call; an unbound root is refused
 * loudly (error log) instead of filed under a placeholder bundle.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger';
import { currentTraceContext } from './tracing';
import { archiveEnabled, encryptArtifact } from './traceArchive';
import { storeWorkerArtifact } from './traceArchiveLifecycle';
import { ownLlmCapture } from './llmCaptureTasks';
import { archiveBindingFor, archiveScopeOwners } from './archiveRootResolver';
import {
  type ArchiveAttempt,
  type ArchiveIdentity,
  type ArchiveOutput,
  type ArchiveScope,
  buildFinalRecord,
  buildStartRecord,
  finalRecordPath,
  isBoundArchiveId,
  startRecordPath,
} from './llmArchiveRecord';
import type { ArchiveAttemptSink, RoseStreamChunk } from './rose/types';

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
  dump_id?: string;
  agent_id?: string | null;
  root_agent_id?: string | null;
  span_id?: string | null;
  model?: string | null;
  message_count: number;
  messages: unknown[];
  config?: Record<string, unknown>;
  response_format?: unknown;
  tools?: unknown[];
  extra?: Record<string, unknown>;
  /** Deferred binding (used when root_agent_id is absent); never resolved on the call path. */
  archive_scope?: ArchiveScope;
}

export function dumpLlmContext(payload: LlmDumpPayload): string | null {
  if (isProduction()) return null;

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
  if (isProduction() || dumpPath === null) return;

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

/** Losing hedge branches report after their abort settles; never wait on them forever. */
const ATTEMPT_DRAIN_TIMEOUT_MS = 10_000;

/** Collects losing race legs for the final record (sink passed through CompletionOptions). */
export interface AttemptCollector extends ArchiveAttemptSink {
  lost: Array<{ branch: string; chunks: readonly RoseStreamChunk[] }>;
  drains: Promise<void>[];
}

export function createAttemptCollector(): AttemptCollector {
  const collector: AttemptCollector = {
    lost: [],
    drains: [],
    lostRace(branch, chunks) {
      collector.lost.push({ branch, chunks });
    },
    drained(settled) {
      collector.drains.push(settled.catch(() => undefined));
    },
  };
  return collector;
}

async function waitForAttempts(collector: AttemptCollector): Promise<void> {
  if (collector.drains.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ATTEMPT_DRAIN_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.all(collector.drains), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Archive completion at the finalizer; model streaming never waits on archive I/O. */
export interface LlmCapture {
  localPath: string | null;
  agentId: string;
  /** Null when the caller supplied no bound root: nothing is archived (logged loudly). */
  identity: ArchiveIdentity | null;
  /** archive_scope binding, resolved in the background (start and final records share it). */
  deferred?: DeferredIdentity;
  startedAtMs: number;
  attempts: AttemptCollector;
}

interface DeferredIdentity {
  /** Synchronous capture owners, so drainLlmCaptures waits before the root is known. */
  agentId: string;
  ownerRoot: string;
  identity: Promise<ArchiveIdentity>;
}

export interface LlmCaptureFinish {
  model: string | null;
  output: ArchiveOutput;
  /** Converts collected losing legs into schema attempts at write time. */
  attempts?: (lost: AttemptCollector['lost']) => ArchiveAttempt[];
  extra?: Record<string, unknown>;
}

function refuseUnbound(payload: LlmDumpPayload, agentId: string): void {
  log.error('llm.archive.unbound_root_refused', {
    call_site: payload.call_site,
    agent_id: agentId || null,
    root_agent_id: payload.root_agent_id ?? null,
    archive_scope: payload.archive_scope ?? null,
    message: 'LLM archive record not written: caller passed no bound root_agent_id',
  });
}

type StartRecordFields = Parameters<typeof buildStartRecord>[1];

/** archive_scope path: owners now, root + start record in the background task. */
function startDeferredCapture(
  payload: LlmDumpPayload,
  scope: ArchiveScope,
  ids: { spanId: string; dumpId: string },
  fields: StartRecordFields
): DeferredIdentity | null {
  const owners = archiveScopeOwners(scope);
  if (owners === null) return null;
  const identity = archiveBindingFor(scope).then((binding) => {
    if (binding === null) throw new Error('archive_scope lost its binding');
    return {
      call_site: payload.call_site,
      agent_id: binding.agent_id,
      root_agent_id: binding.root_agent_id,
      span_id: ids.spanId,
      dump_id: ids.dumpId,
    };
  });
  const deferred: DeferredIdentity = { ...owners, identity };
  ownDeferred(
    deferred,
    identity.then((bound) =>
      persistRecord(
        bound,
        startRecordPath(bound.dump_id),
        buildStartRecord(bound, fields),
        fields.started_at_ms
      )
    )
  );
  return deferred;
}

/** Capture identities, the start clock and the crash-safe start record before streaming. */
export function startLlmCapture(payload: LlmDumpPayload): LlmCapture {
  const trace = currentTraceContext();
  const scope = isBoundArchiveId(payload.root_agent_id) ? undefined : payload.archive_scope;
  const scopeAgentId = scope === undefined ? undefined : archiveScopeOwners(scope)?.agentId;
  const agentId = scopeAgentId || payload.agent_id || trace?.agent_id || '';
  const rootAgentId = payload.root_agent_id ?? null;
  const spanId = payload.span_id || trace?.span_id || randomUUID();
  const dumpId = randomUUID();
  const startedAtMs = Date.now();
  const attempts = createAttemptCollector();
  const localPath = dumpLlmContext({
    ...payload,
    agent_id: agentId || 'unbound',
    span_id: spanId,
    dump_id: dumpId,
  } as LlmDumpPayload);
  if (!archiveEnabled()) return { localPath, agentId, identity: null, startedAtMs, attempts };
  const fields: StartRecordFields = {
    started_at_ms: startedAtMs,
    model: payload.model ?? null,
    message_count: payload.message_count,
    messages: payload.messages,
    config: payload.config ?? {},
    ...(payload.response_format !== undefined ? { response_format: payload.response_format } : {}),
    ...(payload.tools !== undefined ? { tools: payload.tools } : {}),
    ...(payload.extra !== undefined ? { extra: payload.extra } : {}),
  };
  if (scope !== undefined) {
    const deferred = startDeferredCapture(payload, scope, { spanId, dumpId }, fields);
    if (deferred === null) refuseUnbound(payload, agentId);
    return {
      localPath,
      agentId,
      identity: null,
      ...(deferred !== null ? { deferred } : {}),
      startedAtMs,
      attempts,
    };
  }
  if (!isBoundArchiveId(rootAgentId) || !isBoundArchiveId(agentId)) {
    refuseUnbound(payload, agentId);
    return { localPath, agentId, identity: null, startedAtMs, attempts };
  }
  const identity: ArchiveIdentity = {
    call_site: payload.call_site,
    agent_id: agentId,
    root_agent_id: rootAgentId,
    span_id: spanId,
    dump_id: dumpId,
  };
  own(
    identity,
    persistRecord(
      identity,
      startRecordPath(dumpId),
      buildStartRecord(identity, fields),
      startedAtMs
    )
  );
  return { localPath, agentId, identity, startedAtMs, attempts };
}

/** The capture's archive root once bound (after the model call; null when unarchived). */
export async function llmCaptureRoot(capture: LlmCapture): Promise<string | null> {
  if (capture.identity !== null) return capture.identity.root_agent_id;
  if (capture.deferred === undefined) return null;
  return (await capture.deferred.identity).root_agent_id;
}

/** Register the final record with both owners without blocking stream return. */
export function finishLlmCapture(capture: LlmCapture, finish: LlmCaptureFinish): void {
  const finishedAtMs = Date.now();
  updateLlmDump(capture.localPath, {
    record: 'final',
    model: finish.model,
    finished_at_ms: finishedAtMs,
    output: finish.output,
    attempts: finish.attempts?.(capture.attempts.lost) ?? [],
    extra: finish.extra ?? {},
  });
  const { identity: explicit, deferred } = capture;
  const binding = explicit !== null ? Promise.resolve(explicit) : deferred?.identity;
  if (binding === undefined) return;
  const task = (async () => {
    const identity = await binding;
    await waitForAttempts(capture.attempts);
    const attempts = finish.attempts?.(capture.attempts.lost) ?? [];
    const record = buildFinalRecord(identity, {
      finished_at_ms: finishedAtMs,
      model: finish.model,
      output: finish.output,
      ...(attempts.length > 0 ? { attempts } : {}),
      ...(finish.extra !== undefined ? { extra: finish.extra } : {}),
    });
    const finalPath = finalRecordPath(identity.dump_id, finishedAtMs, identity.call_site);
    await persistRecord(identity, finalPath, record, finishedAtMs);
  })();
  if (explicit !== null) own(explicit, task);
  else if (deferred !== undefined) ownDeferred(deferred, task);
}

function own(identity: ArchiveIdentity, task: Promise<void>): void {
  const logged = task.catch((error: unknown) => {
    log.warn('llm.context.archive_failed', {
      agent_id: identity.agent_id,
      root_agent_id: identity.root_agent_id,
      dump_id: identity.dump_id,
      error: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  });
  ownLlmCapture(identity.agent_id, logged, identity.root_agent_id);
}

function ownDeferred(deferred: DeferredIdentity, task: Promise<void>): void {
  const logged = task.catch((error: unknown) => {
    log.warn('llm.context.archive_failed', {
      agent_id: deferred.agentId,
      owner_root: deferred.ownerRoot,
      error: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  });
  ownLlmCapture(deferred.agentId, logged, deferred.ownerRoot);
}

/** Encrypt one record under its explicit root, stamped with its captured clock. */
async function persistRecord(
  identity: ArchiveIdentity,
  objectPath: string,
  record: unknown,
  recordedAtMs: number
): Promise<void> {
  const encrypted = encryptArtifact(
    objectPath,
    Buffer.from(safeJson(record)),
    'application/json',
    true
  );
  if (!encrypted) throw new Error('LLM archive encryption unavailable');
  encrypted.metadata.created_at_ms = recordedAtMs;
  await storeWorkerArtifact({
    rootAgentId: identity.root_agent_id,
    path: objectPath,
    ciphertextB64: encrypted.ciphertext.toString('base64'),
    metadata: encrypted.metadata,
  });
}
