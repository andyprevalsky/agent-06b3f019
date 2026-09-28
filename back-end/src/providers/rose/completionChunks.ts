/**
 * Maps RoseStreamChunk events onto the OpenAI-shaped CompletionChunk DTO
 * chat callers iterate. Isolated from client.ts so the orchestrator stays
 * under the 600-line lint cap.
 */

import type { CompletionChunk, CompletionOptions, RoseStreamChunk } from './types';

export function dumpDisplayModel(actualModel: string): string {
  if (actualModel.endsWith('-claude')) return actualModel.slice(0, -'-claude'.length);
  if (actualModel.endsWith('-gpt')) return actualModel.slice(0, -'-gpt'.length);
  if (actualModel.endsWith('-openai')) return actualModel.slice(0, -'-openai'.length);
  return actualModel;
}

export interface StreamAccumulator {
  metadata: { actual_model: string; pool_name: string };
  outputParts: string[];
  reasoningParts: string[];
  toolCalls: Array<Record<string, unknown>>;
  finishReason: string | null;
}

export function createStreamAccumulator(): StreamAccumulator {
  return {
    metadata: { actual_model: '', pool_name: '' },
    outputParts: [],
    reasoningParts: [],
    toolCalls: [],
    finishReason: null,
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
  if (chunk.kind === 'metadata') {
    acc.metadata = {
      actual_model: chunk.data.actual_model ?? '',
      pool_name: chunk.data.pool_name ?? '',
    };
    // Caller doesn't need a dedicated metadata chunk — every CompletionChunk
    // we emit carries actual_model + pool_name inline (parity with the
    // deleted edge function's behavior).
    return null;
  }
  if (chunk.kind === 'content') {
    acc.outputParts.push(chunk.data.text);
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
    acc.reasoningParts.push(chunk.data.text);
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
    acc.finishReason = chunk.data.finish_reason ?? 'stop';
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
    acc.toolCalls.push({
      id: chunk.data.id,
      name: chunk.data.name,
      arguments: chunk.data.arguments,
    });
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
