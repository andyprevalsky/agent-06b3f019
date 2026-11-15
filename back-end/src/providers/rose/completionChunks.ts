/**
 * Maps RoseStreamChunk events onto the OpenAI-shaped CompletionChunk DTO
 * chat callers iterate. Isolated from client.ts so the orchestrator stays
 * under the 600-line lint cap.
 */

import type { CompletionChunk, CompletionOptions, ReasoningBlock, RoseStreamChunk } from './types';
import { archiveError, normalizeUsage, providerFor, type ArchiveOutput } from '../llmArchiveRecord';

export function dumpDisplayModel(actualModel: string): string {
  if (actualModel.endsWith('-claude')) return actualModel.slice(0, -'-claude'.length);
  if (actualModel.endsWith('-gpt')) return actualModel.slice(0, -'-gpt'.length);
  if (actualModel.endsWith('-openai')) return actualModel.slice(0, -'-openai'.length);
  if (actualModel.endsWith('-foundry')) return actualModel.slice(0, -'-foundry'.length);
  return actualModel;
}

export interface StreamAccumulator {
  metadata: { actual_model: string; pool_name: string; request_id: string };
  outputParts: string[];
  reasoningParts: string[];
  reasoningBlocks: ReasoningBlock[];
  codexReasoningItems: Array<Record<string, unknown>>;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: Extract<RoseStreamChunk, { kind: 'usage' }>['data'] | null;
  finishReason: string | null;
  startedAtMs: number;
  firstOutputAtMs: number | null;
}

export function createStreamAccumulator(startedAtMs = Date.now()): StreamAccumulator {
  return {
    metadata: { actual_model: '', pool_name: '', request_id: '' },
    outputParts: [],
    reasoningParts: [],
    reasoningBlocks: [],
    codexReasoningItems: [],
    toolCalls: [],
    usage: null,
    finishReason: null,
    startedAtMs,
    firstOutputAtMs: null,
  };
}

/** Record one provider chunk for the archive (caller-visible or not). */
export function foldRoseChunk(acc: StreamAccumulator, chunk: RoseStreamChunk): void {
  if (chunk.kind === 'metadata') {
    acc.metadata = {
      actual_model: chunk.data.actual_model ?? '',
      pool_name: chunk.data.pool_name ?? '',
      request_id: chunk.data.request_id ?? '',
    };
    return;
  }
  if (chunk.kind !== 'done' && chunk.kind !== 'usage') acc.firstOutputAtMs ??= Date.now();
  if (chunk.kind === 'content') acc.outputParts.push(chunk.data.text);
  else if (chunk.kind === 'reasoning') acc.reasoningParts.push(chunk.data.text);
  else if (chunk.kind === 'reasoning_block') acc.reasoningBlocks.push(chunk.data);
  else if (chunk.kind === 'tool_call') {
    acc.toolCalls.push({
      id: chunk.data.id,
      name: chunk.data.name,
      arguments: chunk.data.arguments,
    });
  } else if (chunk.kind === 'codex_reasoning_item') {
    acc.codexReasoningItems.push(chunk.data);
    acc.reasoningBlocks.push({
      type: 'openai_reasoning_item',
      id: typeof chunk.data.id === 'string' ? chunk.data.id : null,
      encrypted_content:
        typeof chunk.data.encrypted_content === 'string' ? chunk.data.encrypted_content : null,
      summary: chunk.data.summary ?? null,
    });
  } else if (chunk.kind === 'usage') {
    acc.usage = chunk.data;
    acc.finishReason = chunk.data.finish_reason ?? 'stop';
  }
}

/** The schema's `output` block for everything this accumulator observed. */
export function archiveOutputFromAccumulator(
  acc: StreamAccumulator,
  error?: unknown,
  finishedAtMs = Date.now()
): ArchiveOutput {
  return {
    content: acc.outputParts.join(''),
    reasoning: acc.reasoningParts.join(''),
    reasoning_blocks: acc.reasoningBlocks,
    codex_reasoning_items: acc.codexReasoningItems,
    tool_calls: acc.toolCalls.map((call) => ({
      id: call.id || null,
      name: call.name,
      arguments: call.arguments,
    })),
    usage: normalizeUsage(acc.usage),
    timing: {
      started_at_ms: acc.startedAtMs,
      first_output_ms: acc.firstOutputAtMs === null ? null : acc.firstOutputAtMs - acc.startedAtMs,
      finished_at_ms: finishedAtMs,
      duration_ms: finishedAtMs - acc.startedAtMs,
    },
    request_id: acc.metadata.request_id || null,
    actual_model: acc.metadata.actual_model || null,
    pool_name: acc.metadata.pool_name || null,
    provider: providerFor(acc.metadata.actual_model, acc.metadata.pool_name),
    error: archiveError(error),
  };
}

function baseChunk(
  options: CompletionOptions,
  acc: StreamAccumulator,
  poolSize: number
): Pick<CompletionChunk, 'requested_model' | 'actual_model' | 'pool_name' | 'pool_size'> {
  return {
    requested_model: options.model,
    actual_model: acc.metadata.actual_model,
    pool_name: acc.metadata.pool_name,
    pool_size: poolSize,
  };
}

export function emitRoseChunk(params: {
  chunk: RoseStreamChunk;
  options: CompletionOptions;
  poolSize: number;
  acc: StreamAccumulator;
}): CompletionChunk | null {
  const { chunk, options, poolSize, acc } = params;
  foldRoseChunk(acc, chunk);
  // Caller doesn't need a dedicated metadata chunk — every CompletionChunk
  // we emit carries actual_model + pool_name inline (parity with the
  // deleted edge function's behavior). Reasoning blocks are archive-only.
  if (chunk.kind === 'metadata' || chunk.kind === 'reasoning_block') return null;
  if (chunk.kind === 'content') {
    return {
      choices: [
        {
          index: 0,
          delta: {
            content: chunk.data.text,
            item_id: chunk.data.item_id,
            output_index: chunk.data.output_index,
            content_index: chunk.data.content_index,
            phase: chunk.data.phase,
          },
          finish_reason: null,
        },
      ],
      ...baseChunk(options, acc, poolSize),
    };
  }
  if (chunk.kind === 'reasoning') {
    return {
      choices: [
        {
          index: 0,
          delta: {
            reasoning: chunk.data.text,
            item_id: chunk.data.item_id,
            output_index: chunk.data.output_index,
            content_index: chunk.data.content_index,
            phase: chunk.data.phase,
          },
          finish_reason: null,
        },
      ],
      ...baseChunk(options, acc, poolSize),
    };
  }
  if (chunk.kind === 'usage') {
    return {
      choices: [{ index: 0, delta: {}, finish_reason: chunk.data.finish_reason ?? 'stop' }],
      ...baseChunk(options, acc, poolSize),
      usage: {
        prompt_tokens: chunk.data.prompt_tokens ?? 0,
        completion_tokens: chunk.data.completion_tokens ?? 0,
        total_tokens: chunk.data.total_tokens ?? 0,
        cache_creation_input_tokens: chunk.data.cache_creation_input_tokens,
        cache_read_input_tokens: chunk.data.cache_read_input_tokens,
      },
    };
  }
  if (chunk.kind === 'tool_call') {
    return {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                id: chunk.data.id,
                type: 'function',
                function: { name: chunk.data.name, arguments: chunk.data.arguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      ...baseChunk(options, acc, poolSize),
    };
  }
  if (chunk.kind === 'codex_reasoning_item') {
    return {
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      ...baseChunk(options, acc, poolSize),
      codex_reasoning_item: chunk.data,
    };
  }
  return null;
}
