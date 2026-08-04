/**
 * SMS Supervisor LLM call.
 *
 * Owns exactly one thing: turn a list of messages into a `SupervisorResponse`.
 * Streams a rose-1-lite completion, honours the per-user blackbox fixture
 * override, and shapes the consumed stream into `{ reasoning, tool_calls }`
 * whether the model answered with native tool_use blocks or with the
 * structured-output JSON envelope as content.
 *
 * Split out of supervisorHandler.ts so the handler file stays about the tool
 * loop (rounds, delivery, commit gating) and nothing else.
 */

import { createStreamingCompletion, CompletionMessage } from '../rose';
import { StructuredOutputAccumulator } from '../rose/structuredOutput';
import { createLogger } from '../logger';
import { SUPERVISOR_RESPONSE_MODEL } from './schema';
import { loadBlackboxSupervisorResponseFixture } from './supervisorFixtures';
import type { ToolCall } from './supervisorTools';

const log = createLogger('SmsSupervisor');

export const SMS_SUPERVISOR_MODEL = 'rose-labs/rose-1-lite';

/**
 * Benchmark-only model/route override.
 *
 * Lets an eval ask "is this defect ours or this model's?" by running the exact
 * same task against a different model with everything else identical. Unset in
 * prod, where the supervisor always takes the Cerebras route below.
 */
function supervisorModelAndRoute(): { model: string; providerRoute: string } {
  const override = process.env.BENCHMARK_SMS_SUPERVISOR_MODEL;
  if (override !== undefined && override !== '') {
    return {
      model: override,
      providerRoute: process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE ?? 'openrouter-waterfall',
    };
  }
  return { model: SMS_SUPERVISOR_MODEL, providerRoute: 'direct-cerebras' };
}

export interface SupervisorResponse {
  reasoning: string;
  tool_calls: ToolCall[];
}

export async function callSupervisorLlm(
  messages: CompletionMessage[],
  userId: string
): Promise<SupervisorResponse> {
  const startTime = Date.now();

  // Log the full request
  log.info('[SmsSupervisorLLM] Request', {
    model: SMS_SUPERVISOR_MODEL,
    messageCount: messages.length,
    providerRoute: 'direct-cerebras',
    systemPromptLength: messages[0]?.content
      ? typeof messages[0].content === 'string'
        ? messages[0].content.length
        : 0
      : 0,
    messages: messages.map((m, i) => ({
      index: i,
      role: m.role,
      contentLength: typeof m.content === 'string' ? m.content.length : 0,
      contentPreview: typeof m.content === 'string' ? m.content.substring(0, 100) : '[non-string]',
    })),
  });

  const blackboxFixture = loadBlackboxSupervisorResponseFixture(userId);
  if (blackboxFixture) {
    if (blackboxFixture.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, blackboxFixture.delayMs));
    }
    log.info('[SmsSupervisorLLM] Using blackbox response fixture', {
      toolCallCount: blackboxFixture.response.tool_calls.length,
      delayMs: blackboxFixture.delayMs,
      durationMs: Date.now() - startTime,
    });
    return blackboxFixture.response;
  }

  // Consume streaming response fully (no FE broadcast needed)
  // Same provider path as the backend chat loop: Cerebras GLM-4.7 first, with
  // the route's own failover behind it — quota/rate (402/429) spills to the
  // same model via OpenRouter with the provider unpinned, and stalls/5xx/empty
  // streams fall through to the generic waterfall. The SMS agent must not break
  // on a single provider having a bad minute.
  //
  // Deliberately NOT claudeAuth. Routing SMS straight to Anthropic made this
  // surface's reliability depend on the user's OAuth token, an API key with a
  // credit balance, and a schema small enough for Anthropic's union-type
  // ceiling. On 2026-07-28 all three failed at once and every supervisor turn
  // degraded silently to a waterfall model, with nothing surfacing the switch.
  const { model: activeModel, providerRoute } = supervisorModelAndRoute();
  const stream = await createStreamingCompletion({
    model: activeModel,
    messages,
    temperature: 0.3,
    response_model: SUPERVISOR_RESPONSE_MODEL,
    provider_route: providerRoute as never,
  });

  let accumulatedContent = '';
  const structuredOutput = new StructuredOutputAccumulator();
  let accumulatedReasoning = '';
  const accumulatedToolCalls: ToolCall[] = [];
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
  let actualModel = '';
  let poolName = '';

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      structuredOutput.addCompletionChunk(chunk);
      accumulatedContent = structuredOutput.currentText();
    }
    if (choice?.delta?.reasoning) {
      accumulatedReasoning += choice.delta.reasoning;
    }
    if (choice?.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const name = tc.function?.name;
        const argsStr = tc.function?.arguments ?? '';
        if (!name) continue;
        try {
          const parsedInput = argsStr ? JSON.parse(argsStr) : {};
          // Native-tool path: the response_format envelope nests real args under
          // `arguments`, so the tool_use input is `{ arguments: {...} }` and we
          // unwrap it; if the model emitted the args flat, take them as-is.
          const innerArgs =
            parsedInput && typeof parsedInput === 'object' && 'arguments' in parsedInput
              ? (parsedInput as { arguments: Record<string, unknown> }).arguments
              : (parsedInput as Record<string, unknown>);
          accumulatedToolCalls.push({ tool: name, arguments: innerArgs ?? {} });
        } catch (err) {
          log.warn('[SmsSupervisorLLM] Failed to parse tool_use arguments', {
            tool: name,
            argsPreview: argsStr.substring(0, 200),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }
    if (chunk.actual_model) {
      actualModel = chunk.actual_model;
    }
    if (chunk.pool_name) {
      poolName = chunk.pool_name;
    }
  }

  log.info('[SmsSupervisorLLM] Response stream consumed', {
    contentLength: accumulatedContent.length,
    reasoningLength: accumulatedReasoning.length,
    toolCallCount: accumulatedToolCalls.length,
    actualModel,
    poolName,
    usage,
    durationMs: Date.now() - startTime,
  });

  return finalizeSupervisorResponse(accumulatedToolCalls, structuredOutput, accumulatedReasoning);
}

/**
 * Shape the consumed supervisor stream into a SupervisorResponse.
 *
 * Two response shapes are possible:
 *   - Native-tool path: the model emitted tool_use blocks → use them directly.
 *   - Content path: the structured-output JSON envelope arrived as content
 *     (Codex / waterfall, or claudeAuth when extraction didn't fit the schema).
 *
 * When the model emits NEITHER — a reasoning-only or empty stream — the
 * structured-output extractor cannot select a single item. That extraction is
 * wrapped in the same try/catch as JSON parsing so a StructuredOutputCardinality
 * error degrades to the deliberate "never send raw garbage to the user" fallback
 * instead of throwing out of the supervisor turn.
 */
export function finalizeSupervisorResponse(
  accumulatedToolCalls: ToolCall[],
  structuredOutput: StructuredOutputAccumulator,
  accumulatedReasoning: string
): SupervisorResponse {
  // Native tool path (claudeAuth + response_model extracted to tools): each
  // tool_use block came through as a tool_calls delta. Use those directly.
  if (accumulatedToolCalls.length > 0) {
    log.info('[SmsSupervisorLLM] Native tool calls received', {
      tools: accumulatedToolCalls.map((tc) => tc.tool),
    });
    return {
      reasoning: accumulatedReasoning,
      tool_calls: accumulatedToolCalls,
    };
  }

  // The structured-output JSON envelope arrived as content (Codex / waterfall
  // path, or claudeAuth when extraction didn't fit the schema shape). finalText()
  // is INSIDE the try: a reasoning-only / empty / ambiguous stream makes the
  // extractor throw StructuredOutputCardinalityError — the same "the model gave
  // us nothing actionable this round" condition as a JSON parse failure.
  //
  // On that failure we return NO tool calls rather than throwing (which crashed
  // the whole turn) or injecting an apology (which gave up on the first empty
  // round). An empty tool_calls response routes into the supervisor loop's
  // existing nudge-and-retry ("No tool calls and no attempt_completion" →
  // re-prompt), so a transient empty stream gets another round to actually
  // answer. If every round stays empty, the loop's terminal net delivers one
  // friendly apology. Bounded by MAX_TOOL_ROUNDS.
  let accumulatedContent = '';
  let parsed: SupervisorResponse;
  try {
    accumulatedContent = structuredOutput.finalText();
    const candidate: unknown = JSON.parse(accumulatedContent);
    // `JSON.parse` happily returns `null`, `"Red"`, or `3`. Reading
    // `.reasoning` off those either throws or silently yields an empty turn,
    // so treat any non-object envelope as a parse failure and take the
    // existing nudge-retry path.
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`Structured output was not a JSON object (got ${typeof candidate})`);
    }
    parsed = candidate as SupervisorResponse;
  } catch (error) {
    log.error('[SmsSupervisorLLM] No actionable structured output; nudging for a retry round', {
      error: error instanceof Error ? error.message : String(error),
      rawContent: accumulatedContent.substring(0, 500),
      contentLength: accumulatedContent.length,
    });
    return { reasoning: accumulatedReasoning, tool_calls: [] };
  }

  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
  // Entries come from provider JSON, so an array is no guarantee its members are
  // objects with a `tool`. Drop malformed entries here rather than letting them
  // reach the dispatcher (or throw inside this log call).
  const rawToolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
  const toolCalls = rawToolCalls.filter(
    (tc): tc is (typeof rawToolCalls)[number] =>
      tc !== null && typeof tc === 'object' && typeof (tc as { tool?: unknown }).tool === 'string'
  );
  if (toolCalls.length !== rawToolCalls.length) {
    log.warn('[SmsSupervisorLLM] Discarded malformed tool_call entries', {
      received: rawToolCalls.length,
      usable: toolCalls.length,
    });
  }

  log.info('[SmsSupervisorLLM] Parsed response', {
    reasoning: reasoning.substring(0, 300),
    toolCallCount: toolCalls.length,
    toolCalls: toolCalls.map((tc) => ({
      tool: tc.tool,
      args: JSON.stringify(tc.arguments ?? {}).substring(0, 100),
    })),
  });

  return {
    reasoning,
    tool_calls: toolCalls,
  };
}
