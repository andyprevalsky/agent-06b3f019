/**
 * SMS Supervisor LLM call.
 *
 * Owns exactly one thing: turn a list of messages into a `SupervisorResponse`.
 * Streams a rose-1-lite completion (Cerebras-first), honours the per-user
 * blackbox fixture override, and shapes the consumed stream into
 * `{ reasoning, tool_calls }` whether the model answered with native tool_use
 * blocks or with the structured-output JSON envelope as content.
 *
 * Split out of supervisorHandler.ts so the handler stays about the tool loop.
 */

import { createStreamingCompletion, CompletionMessage, CompletionOptions } from '../rose';
import { StructuredOutputAccumulator } from '../rose/structuredOutput';
import { createLogger } from '../logger';
import { SUPERVISOR_RESPONSE_MODEL } from './schema';
import { loadBlackboxSupervisorResponseFixture } from './supervisorFixtures';
import type { SupervisorComputeToken } from './supervisorComputeToken';
import type { ToolCall } from './supervisorTools';

const log = createLogger('SmsSupervisor');

export const SMS_SUPERVISOR_MODEL = 'rose-labs/rose-1-lite';

export interface SupervisorResponse {
  reasoning: string;
  tool_calls: ToolCall[];
}

export async function callSupervisorLlm(
  messages: CompletionMessage[],
  computeToken: SupervisorComputeToken | null,
  userId: string
): Promise<SupervisorResponse> {
  const startTime = Date.now();
  const claudeToken = computeToken?.type === 'claude' ? computeToken.accessToken : null;
  const gptToken = computeToken?.type === 'gpt' ? computeToken.accessToken : null;
  const gptAccountId = computeToken?.type === 'gpt' ? computeToken.accountId : undefined;

  // Same provider path as chat: Cerebras GLM first, with that route's own
  // failover (quota/rate → OpenRouter unpinned same-model → generic waterfall).
  // Do not prefer claudeAuth here — SMS reliability must not depend on a user
  // OAuth token / funded Anthropic key / Anthropic union-schema ceiling.
  // BENCHMARK_SMS_SUPERVISOR_MODEL(+_ROUTE) overrides for eval isolation only.
  const modelOverride = process.env.BENCHMARK_SMS_SUPERVISOR_MODEL;
  const activeModel =
    modelOverride !== undefined && modelOverride !== '' ? modelOverride : SMS_SUPERVISOR_MODEL;
  const routeOverride = process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE;
  const providerRoute: NonNullable<CompletionOptions['provider_route']> =
    modelOverride !== undefined && modelOverride !== ''
      ? routeOverride === 'direct-cerebras' ||
        routeOverride === 'openrouter-cerebras' ||
        routeOverride === 'shared-openai-priority' ||
        routeOverride === 'openrouter-waterfall'
        ? routeOverride
        : 'openrouter-waterfall'
      : 'direct-cerebras';

  log.info('[SmsSupervisorLLM] Request', {
    model: activeModel,
    providerRoute,
    messageCount: messages.length,
    hasClaudeToken: !!claudeToken && providerRoute !== 'direct-cerebras',
    hasGptToken: !!gptToken && providerRoute !== 'direct-cerebras',
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

  const stream = await createStreamingCompletion({
    model: activeModel,
    messages,
    temperature: 0.3,
    response_model: SUPERVISOR_RESPONSE_MODEL,
    provider_route: providerRoute,
    ...(providerRoute !== 'direct-cerebras' && claudeToken ? { claude_token: claudeToken } : {}),
    ...(providerRoute !== 'direct-cerebras' && gptToken
      ? { gpt_token: gptToken, gpt_account_id: gptAccountId }
      : {}),
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
 * When the model emits NEITHER — a reasoning-only or empty stream — return
 * empty tool_calls so the supervisor loop can nudge-and-retry.
 */
export function finalizeSupervisorResponse(
  accumulatedToolCalls: ToolCall[],
  structuredOutput: StructuredOutputAccumulator,
  accumulatedReasoning: string
): SupervisorResponse {
  if (accumulatedToolCalls.length > 0) {
    log.info('[SmsSupervisorLLM] Native tool calls received', {
      tools: accumulatedToolCalls.map((tc) => tc.tool),
    });
    return {
      reasoning: accumulatedReasoning,
      tool_calls: accumulatedToolCalls,
    };
  }

  let accumulatedContent = '';
  let parsed: SupervisorResponse;
  try {
    accumulatedContent = structuredOutput.finalText();
    parsed = JSON.parse(accumulatedContent) as SupervisorResponse;
  } catch (error) {
    log.error('[SmsSupervisorLLM] No actionable structured output; nudging for a retry round', {
      error: error instanceof Error ? error.message : String(error),
      rawContent: accumulatedContent.substring(0, 500),
      contentLength: accumulatedContent.length,
    });
    return { reasoning: accumulatedReasoning, tool_calls: [] };
  }

  log.info('[SmsSupervisorLLM] Parsed response', {
    reasoning: parsed.reasoning.substring(0, 300),
    toolCallCount: parsed.tool_calls?.length || 0,
    toolCalls: parsed.tool_calls?.map((tc) => ({
      tool: tc.tool,
      args: JSON.stringify(tc.arguments).substring(0, 100),
    })),
  });

  return {
    reasoning: parsed.reasoning || '',
    tool_calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [],
  };
}
