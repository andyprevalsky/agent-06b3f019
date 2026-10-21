/** Loopback-only llama-server transport. No remote fallback or request dump. */
import { buildOpenAiResponseFormat } from './schema';
import { createStreamAccumulator, emitRoseChunk } from './completionChunks';
import { parseOpenAISSE } from './streaming';
import { openAiChatToolChoice, openAiChatTools } from './toolContract';
import { normalizeOpenAiToolCalls, withNativeToolContract } from './transforms';
import type { CompletionChunk, CompletionOptions } from './types';

function localConfig(): { base: string; model: string } {
  const raw = process.env.ROSE_LOCAL_BASE_URL ?? 'http://127.0.0.1:8080/v1';
  const url = new URL(raw);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error('Rose Local requires an HTTP loopback endpoint');
  }
  const model = process.env.ROSE_LOCAL_MODEL?.trim();
  if (!model) throw new Error('Rose Local requires ROSE_LOCAL_MODEL');
  return { base: raw.replace(/\/$/, ''), model };
}

export async function* localCompletion(options: CompletionOptions): AsyncIterable<CompletionChunk> {
  const { base, model } = localConfig();
  const normalized = withNativeToolContract({
    ...options,
    response_format: options.response_model
      ? buildOpenAiResponseFormat(options.response_model)
      : options.response_format,
  });
  const tools = openAiChatTools(normalized.tools);
  const body: Record<string, unknown> = {
    model,
    messages: normalizeOpenAiToolCalls(normalized.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools) {
    body.tools = tools;
    if (normalized.tool_choice !== undefined) {
      body.tool_choice = openAiChatToolChoice(normalized.tool_choice, model);
    }
  } else if (normalized.response_format) {
    body.response_format = normalized.response_format;
  }
  if (normalized.temperature !== undefined) body.temperature = normalized.temperature;
  if (normalized.max_tokens !== undefined) body.max_tokens = normalized.max_tokens;

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.abort_signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Rose Local returned HTTP ${response.status}`);
  }
  const acc = createStreamAccumulator();
  for await (const chunk of parseOpenAISSE(response.body, {
    actualModel: `local/${model}`,
    poolName: 'rose-local',
    requestId: crypto.randomUUID(),
  })) {
    const output = emitRoseChunk({ chunk, options, poolSize: 1, acc });
    if (output) yield output;
  }
}
