/**
 * Standard archived LLM call record (v2) for the TypeScript writer.
 *
 * Contract: shared/llm-archive-record/record.schema.json. Field names follow
 * the Python writer (agents/helpers/observability.py) so one reader serves both.
 *
 *   call start  ──► llm/<dump_id>.json.gz.enc                      record: 'start'
 *   call finish ──► llm-updates/<dump_id>-<ms>-<call_site>.json.gz.enc  record: 'final'
 *
 * Both land in the ROOT agent's bundle. An unbound root is refused, never filed
 * under a placeholder bundle.
 */

import type { ReasoningBlock, RoseStreamChunk } from './rose/types';

export const LLM_ARCHIVE_SCHEMA_VERSION = 2;

/** Documented root for user-level calls that act on no agent tree (SMS supervisor turns, etc). */
export function userArchiveRoot(userId: string): string {
  return `user-${userId}`;
}

const UNBOUND_IDS = new Set(['unbound', 'none', 'null', 'undefined']);

export class UnboundArchiveRootError extends Error {
  constructor(field: string, value: unknown) {
    super(`LLM archive record refuses an unbound ${field}: ${JSON.stringify(value ?? null)}`);
    this.name = 'UnboundArchiveRootError';
  }
}

/** A real agent/root identity: non-empty and not a placeholder. */
export function isBoundArchiveId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim() !== '' && !UNBOUND_IDS.has(value.trim().toLowerCase())
  );
}

export function assertBoundArchiveId(field: string, value: unknown): string {
  if (!isBoundArchiveId(value)) throw new UnboundArchiveRootError(field, value);
  return value;
}

export interface ArchiveUsage {
  prompt: number | null;
  completion: number | null;
  total: number | null;
  reasoning: number | null;
  cache_creation: number | null;
  cache_read: number | null;
  finish_reason: string | null;
}

export interface ArchiveToolCall {
  id: string | null;
  name: string;
  arguments: unknown;
}

export interface ArchiveOutput {
  content: string;
  reasoning: string;
  reasoning_blocks: ReasoningBlock[];
  codex_reasoning_items: Array<Record<string, unknown>>;
  tool_calls: ArchiveToolCall[];
  structured?: unknown;
  usage: ArchiveUsage;
  timing: Record<string, number | null>;
  request_id: string | null;
  actual_model: string | null;
  pool_name: string | null;
  provider: string | null;
  error: { type: string; message: string } | null;
}

export interface ArchiveAttempt {
  model: string | null;
  pool_name: string | null;
  outcome: 'won' | 'lost_race' | 'fell_through' | 'failed';
  output: ArchiveOutput;
  branch?: string;
}

/**
 * Deferred archive binding carried in memory with an LLM call. The writer
 * resolves the tree root (archiveRootResolver.archiveBindingFor) in its
 * background archive task, so no lookup ever runs before the model call.
 */
export interface ArchiveScope {
  agentId?: string | null;
  userId?: string | null;
  /** Record agent_id for user-level calls (e.g. `sms-supervisor-<userId>`). */
  userLevelAgentId?: string;
}

export interface ArchiveIdentity {
  call_site: string;
  agent_id: string;
  root_agent_id: string;
  span_id: string;
  dump_id: string;
}

export interface StartRecord extends ArchiveIdentity {
  schema_version: 2;
  record: 'start';
  started_at_ms: number;
  model: string | null;
  message_count: number;
  messages: unknown[];
  config: Record<string, unknown>;
  response_format?: unknown;
  tools?: unknown[] | null;
  extra?: Record<string, unknown>;
}

export interface FinalRecord extends ArchiveIdentity {
  schema_version: 2;
  record: 'final';
  finished_at_ms: number;
  model: string | null;
  output: ArchiveOutput;
  attempts?: ArchiveAttempt[];
  extra?: Record<string, unknown>;
}

function requireIdentity(identity: ArchiveIdentity): ArchiveIdentity {
  return {
    call_site: assertBoundArchiveId('call_site', identity.call_site),
    agent_id: assertBoundArchiveId('agent_id', identity.agent_id),
    root_agent_id: assertBoundArchiveId('root_agent_id', identity.root_agent_id),
    span_id: assertBoundArchiveId('span_id', identity.span_id),
    dump_id: assertBoundArchiveId('dump_id', identity.dump_id),
  };
}

export function buildStartRecord(
  identity: ArchiveIdentity,
  fields: Omit<StartRecord, keyof ArchiveIdentity | 'schema_version' | 'record'>
): StartRecord {
  return {
    schema_version: LLM_ARCHIVE_SCHEMA_VERSION,
    record: 'start',
    ...requireIdentity(identity),
    ...fields,
  };
}

export function buildFinalRecord(
  identity: ArchiveIdentity,
  fields: Omit<FinalRecord, keyof ArchiveIdentity | 'schema_version' | 'record'>
): FinalRecord {
  return {
    schema_version: LLM_ARCHIVE_SCHEMA_VERSION,
    record: 'final',
    ...requireIdentity(identity),
    ...fields,
  };
}

export function finalRecordPath(dumpId: string, finishedAtMs: number, callSite: string): string {
  const safeCallSite = callSite.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64) || 'update';
  return `llm-updates/${dumpId}-${finishedAtMs}-${safeCallSite}.json.gz.enc`;
}

export function startRecordPath(dumpId: string): string {
  return `llm/${dumpId}.json.gz.enc`;
}

/** Provider usage chunk → the schema's normalized usage block. */
export function normalizeUsage(
  usage: Extract<RoseStreamChunk, { kind: 'usage' }>['data'] | null
): ArchiveUsage {
  if (usage === null) {
    return {
      prompt: null,
      completion: null,
      total: null,
      reasoning: null,
      cache_creation: null,
      cache_read: null,
      finish_reason: null,
    };
  }
  return {
    prompt: usage.prompt_tokens,
    completion: usage.completion_tokens,
    total: usage.total_tokens,
    reasoning: usage.reasoning_tokens ?? null,
    cache_creation: usage.cache_creation_input_tokens ?? null,
    cache_read: usage.cache_read_input_tokens ?? null,
    finish_reason: usage.finish_reason || null,
  };
}

/** Best-effort serving-provider label from the Rose actual_model suffix / pool. */
export function providerFor(actualModelRaw: string, poolName: string): string | null {
  if (!actualModelRaw && !poolName) return null;
  if (actualModelRaw.endsWith('-claude')) return 'anthropic';
  if (actualModelRaw.endsWith('-gpt')) return 'openai_chatgpt';
  if (actualModelRaw.endsWith('-openai')) return 'openai';
  if (actualModelRaw.endsWith('-foundry')) return 'azure_foundry';
  if (actualModelRaw.startsWith('local/')) return 'local';
  if (poolName.startsWith('cerebras')) return 'cerebras';
  if (actualModelRaw.includes('/')) return 'openrouter';
  return null;
}

export function archiveError(error: unknown): { type: string; message: string } | null {
  if (error === undefined || error === null) return null;
  if (error instanceof Error) return { type: error.name, message: error.message };
  return { type: typeof error, message: String(error) };
}

/** Output block for non-Rose model calls (STT, video, direct SDK calls). */
export function simpleArchiveOutput(params: {
  content: string;
  actualModel: string | null;
  provider: string;
  startedAtMs: number;
  usage?: Partial<ArchiveUsage>;
  requestId?: string | null;
  structured?: unknown;
  error?: unknown;
}): ArchiveOutput {
  const finishedAtMs = Date.now();
  return {
    content: params.content,
    reasoning: '',
    reasoning_blocks: [],
    codex_reasoning_items: [],
    tool_calls: [],
    ...(params.structured !== undefined ? { structured: params.structured } : {}),
    usage: { ...normalizeUsage(null), ...params.usage },
    timing: {
      started_at_ms: params.startedAtMs,
      finished_at_ms: finishedAtMs,
      duration_ms: finishedAtMs - params.startedAtMs,
    },
    request_id: params.requestId ?? null,
    actual_model: params.actualModel,
    pool_name: null,
    provider: params.provider,
    error: archiveError(params.error),
  };
}
