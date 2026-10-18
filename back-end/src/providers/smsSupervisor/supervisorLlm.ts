/**
 * SMS Supervisor LLM call.
 *
 * Owns exactly one thing: turn a list of messages into a `SupervisorResponse`.
 * Streams a rose-fast (rose-1-flash) completion through the normal pool path
 * (Cerebras Qwen → OpenRouter waterfall), honours the per-user blackbox fixture
 * override, and shapes the consumed stream into `{ reasoning, tool_calls }`
 * whether the model answered with native tool_use blocks or with the
 * structured-output JSON envelope as content.
 *
 * Split out of supervisorHandler.ts so the handler stays about the tool loop.
 */

import { createStreamingCompletion, CompletionMessage, CompletionOptions } from '../rose';
import { StructuredOutputAccumulator } from '../rose/structuredOutput';
import { createLogger } from '../logger';
import {
  SmsSupervisorResponseSchema,
  SmsSupervisorToolCallSchema,
  SUPERVISOR_RESPONSE_MODEL,
  SUPERVISOR_REACTION_MODEL,
  SmsSupervisorReactionResponseSchema,
} from './schema';
import { loadBlackboxSupervisorResponseFixture } from './supervisorFixtures';
import {
  benchmarkSupervisorTokenType,
  type SupervisorComputeToken,
} from './supervisorComputeToken';
import type { ToolCall } from './supervisorTools';
import { withCurrentTimeContext } from '../currentTimeContext';

const log = createLogger('SmsSupervisor');

/** Display alias rose-fast; pool id rose-1-flash. */
export const SMS_SUPERVISOR_MODEL = 'rose-labs/rose-1-flash';

export interface SupervisorResponse {
  reasoning: string;
  tool_calls: ToolCall[];
}

export async function callSupervisorLlm(
  messages: CompletionMessage[],
  computeToken: SupervisorComputeToken | null,
  userId: string,
  reactionOnly = false
): Promise<SupervisorResponse> {
  const startTime = Date.now();
  const groundedMessages = withCurrentTimeContext(messages);
  const claudeToken = computeToken?.type === 'claude' ? computeToken.accessToken : null;
  const gptToken = computeToken?.type === 'gpt' ? computeToken.accessToken : null;
  const gptAccountId = computeToken?.type === 'gpt' ? computeToken.accountId : undefined;

  // Default: rose-fast pool path (no provider_route). That hits pool.cerebrasModel
  // (qwen-3.8-27b) then the pool waterfall — NOT the exclusive chat Cerebras
  // route, which hardcodes gpt-oss-120b.
  // BENCHMARK_SMS_SUPERVISOR_MODEL(+_ROUTE) overrides for eval isolation only.
  const modelOverride = process.env.BENCHMARK_SMS_SUPERVISOR_MODEL;
  const activeModel =
    modelOverride !== undefined && modelOverride !== '' ? modelOverride : SMS_SUPERVISOR_MODEL;
  const routeOverride = process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE;
  const hasBenchmarkModel = modelOverride !== undefined && modelOverride !== '';
  // 'pool-default' evaluates another pool on its normal pool path, as it would
  // serve SMS_SUPERVISOR_MODEL. Tokenless by default; with
  // BENCHMARK_SMS_SUPERVISOR_TOKEN_TYPE it carries a leased compute token the way
  // Rose.complete callers reach providers (rose-1-ultra: claude → Opus, gpt → Sol).
  const benchmarkPoolLease =
    hasBenchmarkModel &&
    routeOverride === 'pool-default' &&
    benchmarkSupervisorTokenType() !== undefined;
  const providerRoute: CompletionOptions['provider_route'] | undefined =
    hasBenchmarkModel && routeOverride !== 'pool-default'
      ? routeOverride === 'direct-cerebras' ||
        routeOverride === 'openrouter-cerebras' ||
        routeOverride === 'shared-openai-priority' ||
        routeOverride === 'openrouter-waterfall'
        ? routeOverride
        : 'openrouter-waterfall'
      : undefined;
  // Production's default path stays tokenless (rose-fast has directAuthEnabled=false).
  const sendComputeTokens = providerRoute !== undefined || benchmarkPoolLease;

  log.info('[SmsSupervisorLLM] Request', {
    mode: reactionOnly ? 'reaction' : 'tools',
    model: activeModel,
    providerRoute: providerRoute ?? 'pool-default',
    messageCount: groundedMessages.length,
    hasClaudeToken: !!claudeToken && sendComputeTokens,
    hasGptToken: !!gptToken && sendComputeTokens,
    systemPromptLength: messages[0]?.content
      ? typeof messages[0].content === 'string'
        ? messages[0].content.length
        : 0
      : 0,
    messages: groundedMessages.map((m, i) => ({
      index: i,
      role: m.role,
      contentLength: typeof m.content === 'string' ? m.content.length : 0,
      contentPreview: typeof m.content === 'string' ? m.content.substring(0, 100) : '[non-string]',
    })),
  });

  const blackboxFixture = loadBlackboxSupervisorResponseFixture(
    userId,
    reactionOnly,
    groundedMessages
  );
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
    messages: groundedMessages,
    temperature: 0.3,
    response_model: reactionOnly ? SUPERVISOR_REACTION_MODEL : SUPERVISOR_RESPONSE_MODEL,
    // Dev/benchmark request+response dump (llmDump is a no-op in production), so a
    // supervisor decision can be replayed and its raw output inspected.
    dump_context: { call_site: 'sms_supervisor', agent_id: `sms-supervisor-${userId}` },
    ...(providerRoute !== undefined ? { provider_route: providerRoute } : {}),
    // Compute tokens only on benchmark overrides that need them.
    ...(sendComputeTokens && claudeToken ? { claude_token: claudeToken } : {}),
    ...(sendComputeTokens && gptToken ? { gpt_token: gptToken, gpt_account_id: gptAccountId } : {}),
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
          accumulatedToolCalls.push({
            tool: name,
            arguments: innerArgs ?? {},
            ...(tc.id ? { id: tc.id } : {}),
          });
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

  return reactionOnly
    ? finalizeSupervisorReactionResponse(
        accumulatedToolCalls,
        structuredOutput,
        accumulatedReasoning
      )
    : finalizeSupervisorResponse(accumulatedToolCalls, structuredOutput, accumulatedReasoning);
}

/** Reaction selection can produce exactly one reaction, never other actions. */
export function finalizeSupervisorReactionResponse(
  toolCalls: ToolCall[],
  structuredOutput: StructuredOutputAccumulator,
  reasoning: string
): SupervisorResponse {
  let raw: unknown;
  try {
    raw =
      toolCalls.length > 0
        ? { reasoning, tool_calls: toolCalls }
        : JSON.parse(structuredOutput.currentText());
  } catch {
    return { reasoning, tool_calls: [] };
  }
  const parsed = SmsSupervisorReactionResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : { reasoning, tool_calls: [] };
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
 * error degrades to nudge-and-retry instead of throwing out of the supervisor turn.
 */
export function finalizeSupervisorResponse(
  accumulatedToolCalls: ToolCall[],
  structuredOutput: StructuredOutputAccumulator,
  accumulatedReasoning: string
): SupervisorResponse {
  // Native tool path: each tool_use block came through as a tool_calls delta.
  if (accumulatedToolCalls.length > 0) {
    log.info('[SmsSupervisorLLM] Native tool calls received', {
      tools: accumulatedToolCalls.map((tc) => tc.tool),
    });
    return {
      reasoning: accumulatedReasoning,
      tool_calls: accumulatedToolCalls,
    };
  }

  // Content-path envelope (Codex / waterfall). currentText() never throws
  // cardinality. Empty / unparseable / schema-invalid envelopes nudge-retry.
  const accumulatedContent = structuredOutput.currentText();
  let candidate: unknown;
  try {
    candidate = accumulatedContent ? JSON.parse(accumulatedContent) : null;
  } catch (error) {
    log.error('[SmsSupervisorLLM] No actionable structured output; nudging for a retry round', {
      error: error instanceof Error ? error.message : String(error),
      rawContent: accumulatedContent.substring(0, 500),
      contentLength: accumulatedContent.length,
    });
    return { reasoning: accumulatedReasoning, tool_calls: [] };
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    log.error('[SmsSupervisorLLM] No actionable structured output; nudging for a retry round', {
      error: `Structured output was not a JSON object (got ${typeof candidate})`,
      rawContent: accumulatedContent.substring(0, 500),
      contentLength: accumulatedContent.length,
    });
    return { reasoning: accumulatedReasoning, tool_calls: [] };
  }

  const raw = candidate as { reasoning?: unknown; tool_calls?: unknown };
  const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : '';
  const rawToolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
  const toolCalls: ToolCall[] = [];
  for (const tc of rawToolCalls) {
    const parsedTool = SmsSupervisorToolCallSchema.safeParse(tc);
    if (parsedTool.success) {
      toolCalls.push({
        tool: parsedTool.data.tool,
        arguments: parsedTool.data.arguments as Record<string, unknown>,
      });
    }
  }
  if (toolCalls.length !== rawToolCalls.length) {
    log.warn('[SmsSupervisorLLM] Discarded malformed tool_call entries', {
      received: rawToolCalls.length,
      usable: toolCalls.length,
    });
  }

  const envelope = SmsSupervisorResponseSchema.safeParse({ reasoning, tool_calls: toolCalls });
  if (!envelope.success) {
    log.error('[SmsSupervisorLLM] No actionable structured output; nudging for a retry round', {
      error: envelope.error.issues[0]?.message ?? 'invalid supervisor envelope',
      rawContent: accumulatedContent.substring(0, 500),
      contentLength: accumulatedContent.length,
    });
    return { reasoning: accumulatedReasoning, tool_calls: [] };
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
