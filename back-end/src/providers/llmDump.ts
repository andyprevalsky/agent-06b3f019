/**
 * DEV-only LLM context dumps for backend Rose calls.
 *
 * Mirrors agents/helpers/observability.py:
 *   .llm-dumps/<agent_id>/<timestamp>-<span_id>-<call_site>.json
 *
 * Production is detected the same way as the Python helper: Fly sets
 * FLY_APP_NAME. Dump failures are best-effort and never affect the LLM call.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger';
import { currentTraceContext } from './tracing';

const log = createLogger('LlmDump');

const IS_PRODUCTION = process.env.FLY_APP_NAME !== undefined;
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

export function dumpLlmContext(payload: LlmDumpPayload): string | null {
  if (IS_PRODUCTION) return null;

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
  if (IS_PRODUCTION || dumpPath === null) return;

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
