/**
 * DEV-only LLM context dumps for backend Rose calls.
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
import { storeWorkerArtifact } from './traceArchiveLifecycle';
import { prisma } from './database';

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
  root_agent_id?: string | null;
  span_id?: string | null;
  model?: string | null;
  message_count: number;
  messages: unknown[];
  config?: Record<string, unknown>;
  response_format?: unknown;
  tools?: unknown[];
  extra?: Record<string, unknown>;
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

/** The encrypted archive is independent of the production plaintext-dump policy. */
export interface LlmCapture {
  localPath: string | null;
  rootAgentId: string;
  agentId: string;
  dumpId: string;
  archived: boolean;
}

export async function startLlmCapture(payload: LlmDumpPayload): Promise<LlmCapture> {
  const trace = currentTraceContext();
  const agentId = payload.agent_id || trace?.agent_id || 'unbound';
  const dumpId = randomUUID();
  const value = {
    ...payload,
    agent_id: agentId,
    root_agent_id: payload.root_agent_id || agentId,
    span_id: payload.span_id || trace?.span_id || randomUUID(),
    dump_id: dumpId,
  };
  const capture: LlmCapture = {
    localPath: dumpLlmContext(value),
    rootAgentId: value.root_agent_id,
    agentId,
    dumpId,
    archived: false,
  };
  try {
    if (!archiveEnabled()) return capture;
    if (!payload.root_agent_id) {
      const agent = await prisma.agent.findUnique({
        where: { id: agentId },
        select: { busId: true },
      });
      if (!agent) return capture;
      capture.rootAgentId = agent.busId || agentId;
      value.root_agent_id = capture.rootAgentId;
    }
    await archiveCaptureValue(capture.rootAgentId, `llm/${dumpId}.json.gz.enc`, value);
    capture.archived = true;
  } catch (error) {
    log.warn('llm.context.archive_failed', {
      agent_id: agentId,
      dump_id: dumpId,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
  return capture;
}

export async function finishLlmCapture(
  capture: LlmCapture,
  patch: Record<string, unknown>
): Promise<void> {
  updateLlmDump(capture.localPath, patch);
  if (!capture.archived) return;
  try {
    await archiveCaptureValue(
      capture.rootAgentId,
      `llm-updates/${capture.dumpId}-${randomUUID()}.json.gz.enc`,
      {
        ...patch,
        agent_id: capture.agentId,
        root_agent_id: capture.rootAgentId,
        dump_id: capture.dumpId,
      }
    );
  } catch (error) {
    log.warn('llm.context.archive_update_failed', {
      agent_id: capture.agentId,
      dump_id: capture.dumpId,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

async function archiveCaptureValue(
  rootAgentId: string,
  objectPath: string,
  value: unknown
): Promise<void> {
  const encrypted = encryptArtifact(
    objectPath,
    Buffer.from(safeJson(value)),
    'application/json',
    true
  );
  if (!encrypted) throw new Error('LLM archive encryption unavailable');
  await storeWorkerArtifact({
    rootAgentId,
    path: objectPath,
    ciphertextB64: encrypted.ciphertext.toString('base64'),
    metadata: encrypted.metadata,
  });
}
