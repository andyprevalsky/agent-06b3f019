/**
 * SMS Supervisor Handler
 *
 * Main orchestrator for the SMS supervisor agent. Receives inbound SMS,
 * builds context, and calls the LLM in a tool loop. `send_user_message` owns
 * delivery; argument-free `attempt_completion` only ends a run that sent.
 *
 * Loop pattern:
 *   1. Call LLM → get { reasoning, tool_calls }
 *   2. Execute tools, delivering send_user_message immediately
 *   3. Accept attempt_completion only after a successful delivery
 *
 * Logs extensively at every boundary: DB reads, LLM calls, tool executions, SMS sends.
 */

import { prisma } from '../database';
import { createStreamingCompletion, CompletionMessage, ContentBlock, markCacheable } from '../rose';
import { StructuredOutputAccumulator } from '../rose/structuredOutput';
import { sendSms } from '../smsQueue';
import { processInboundAttachments, type SurgeAttachment } from './inboundMedia';
import {
  commitPendingWrites,
  dispatchToolCall,
  PendingOp,
  ToolCall,
  ToolResult,
} from './supervisorTools';
import { fetchComputeTokenForUser } from '../computeCredentials';
import { createLogger } from '../logger';
import { SUPERVISOR_RESPONSE_MODEL } from './schema';
import { appendOutboundSms } from './sessionStore';
import * as environment from './environmentMessages';
import { loadBlackboxSupervisorResponseFixture } from './supervisorFixtures';

const log = createLogger('SmsSupervisor');

const SMS_SUPERVISOR_MODEL = 'rose-labs/rose-1-lite';

/**
 * Per-user commit lock. Held while a run flushes pendingWrites + sends SMS +
 * persists transcript so two near-simultaneous attempt_completions cannot
 * interleave their side effects.
 *
 * The seq gate (inside the locked region) is what actually decides whether to
 * commit — the lock just serializes ordering.
 */
const commitLocksByUser = new Map<string, Promise<void>>();
async function withCommitLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = commitLocksByUser.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Anyone arriving after us awaits BOTH the previous holder AND our own
  // release. Storing the chained promise (prev → released) is what keeps
  // the queue strictly ordered.
  const myTurn = prev.then(() => released);
  commitLocksByUser.set(userId, myTurn);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // If no one queued behind us, clear the slot. Otherwise leave the latest
    // entry in place so the next holder's queue remains intact.
    if (commitLocksByUser.get(userId) === myTurn) {
      commitLocksByUser.delete(userId);
    }
  }
}

interface SupervisorResponse {
  reasoning: string;
  tool_calls: ToolCall[];
}

export interface SmsSupervisorResult {
  responseText: string;
  toolsExecuted: string[];
  /** True iff this run successfully delivered and persisted a user-facing reply. */
  committed: boolean;
}

export function buildToolFailureMessage(
  failures: readonly ToolResult[],
  stage: 'execute' | 'commit'
): string {
  const failedTools = failures
    .filter((result) => !result.success)
    .map((result) => `${result.tool}: ${result.error || result.result || 'failed'}`);
  const details = failedTools.length > 0 ? failedTools.join('; ') : 'unknown failure';
  const prefix =
    stage === 'commit'
      ? 'I tried to finish that, but one or more actions failed while applying the changes'
      : 'I tried to finish that, but one or more actions failed';
  return `${prefix}: ${details}. Please try again or open Rose to check the current state.`;
}

/**
 * Handle an inbound SMS message through the supervisor agent.
 *
 * `mySeq` is the value of `SmsSession.lastInboundSeq` captured by the webhook
 * layer when this SMS arrived. At attempt_completion we re-read the persisted
 * value: if it now exceeds `mySeq`, a newer SMS arrived during our run and we
 * discard pendingWrites + skip the SMS so the newer run produces the reply.
 */
export async function handleSmsSupervisorMessage(config: {
  userId: string;
  phoneNumber: string;
  inboundMessage: string;
  mySeq: number;
  inboundAlreadyPersisted?: boolean;
  attachments?: SurgeAttachment[];
  abortSignal?: AbortSignal;
  commitGuard?: () => Promise<boolean>;
}): Promise<SmsSupervisorResult> {
  const { userId, phoneNumber, inboundMessage, mySeq, abortSignal, commitGuard } = config;
  const inboundAlreadyPersisted = config.inboundAlreadyPersisted ?? false;
  const attachments = config.attachments ?? [];
  const overallStart = Date.now();

  log.info('[SmsSupervisor] === START ===', {
    userId,
    phone: phoneNumber.substring(0, 7) + '****',
    messageLength: inboundMessage.length,
    messagePreview: inboundMessage.substring(0, 100),
    attachmentCount: attachments.length,
  });

  // 0. Resolve MMS media: images become multimodal content blocks on the
  // inbound user message; voice notes are transcribed into text lines.
  const media = attachments.length
    ? await processInboundAttachments(attachments)
    : { imageBlocks: [], noteLines: [] };
  const inboundText = [inboundMessage, ...media.noteLines].filter((s) => s !== '').join('\n\n');
  const inboundContent: string | ContentBlock[] =
    media.imageBlocks.length > 0
      ? [
          {
            type: 'text',
            text:
              inboundText !== ''
                ? inboundText
                : 'The user sent the attached photo(s) with no text.',
          },
          ...media.imageBlocks,
        ]
      : inboundText;

  // 1. Build context. The webhook already persisted this inbound SMS; exclude
  // that one stored copy because the richer current-turn content is appended
  // explicitly below (including image blocks / voice transcription).
  const contextStart = Date.now();
  const smsContext = await environment.prepareSmsEnvironment(
    userId,
    mySeq,
    inboundAlreadyPersisted,
    inboundText
  );
  const { systemPrompt, contextUserMessage, sessionHistory, invocationContext } = smsContext;

  log.info('[SmsSupervisor] Context built', {
    userId,
    systemPromptLength: systemPrompt.length,
    contextUserMessageLength: contextUserMessage.length,
    sessionHistoryLength: sessionHistory.length,
    durationMs: Date.now() - contextStart,
  });

  // 2. Fetch Claude token for direct Anthropic passthrough
  const computeToken = await getComputeToken(userId);

  // 3. Build messages for the LLM. The volatile runtime environment is a
  // synthetic get_environment call/result AFTER the newest inbound SMS. It is
  // not persisted, and placing it last preserves prompt-cache reuse through
  // the complete SMS conversation prefix.
  //
  // `markCacheable` makes the cache boundary explicit: the entire system
  // prompt is the cacheable static prefix. See providers/rose/cache.ts.
  const messages: CompletionMessage[] = [
    markCacheable(systemPrompt),
    ...sessionHistory,
    { role: 'user', content: inboundContent },
    ...environment.buildEnvironmentToolMessages(contextUserMessage, mySeq),
  ];
  // 4. LLM call loop. Writes remain deferred behind the sequence gate. SMS
  // delivery is explicit and does not terminate the loop.
  const allToolsExecuted: string[] = [];
  const pendingWrites: PendingOp[] = [];
  const sentMessages: string[] = [];
  let completionAccepted = false;
  let inboundStoredForRun = inboundAlreadyPersisted;

  const runStillOwnsReply = async (): Promise<boolean> => {
    if (abortSignal?.aborted) return false;
    const current = await prisma.smsSession.findUnique({
      where: { userId },
      select: { lastInboundSeq: true },
    });
    if ((current?.lastInboundSeq ?? 0) > mySeq) return false;
    return commitGuard === undefined || (await commitGuard());
  };

  const flushPendingWrites = async (): Promise<ToolResult[]> => {
    if (pendingWrites.length === 0) return [];
    return withCommitLock(userId, async () => {
      if (!(await runStillOwnsReply())) {
        return [
          {
            tool: 'pending_writes',
            success: false,
            result: '',
            error: 'A newer inbound SMS superseded this run',
          },
        ];
      }
      const queued = pendingWrites.splice(0, pendingWrites.length);
      return commitPendingWrites(queued, userId);
    });
  };

  const deliverUserMessage = async (message: string): Promise<ToolResult> =>
    withCommitLock(userId, async () => {
      if (!(await runStillOwnsReply())) {
        return {
          tool: 'send_user_message',
          success: false,
          result: '',
          error: 'A newer inbound SMS superseded this run',
        };
      }
      const smsResult = await sendSms(phoneNumber, message);
      if (!smsResult.success) {
        return {
          tool: 'send_user_message',
          success: false,
          result: '',
          error: smsResult.error ?? 'SMS delivery failed',
        };
      }
      await appendOutboundSms(
        userId,
        message,
        smsResult.messageSid,
        inboundStoredForRun ? undefined : inboundMessage
      );
      inboundStoredForRun = true;
      sentMessages.push(message);
      return { tool: 'send_user_message', success: true, result: 'SMS sent and persisted' };
    });

  for (let round = 0; round < environment.MAX_TOOL_ROUNDS; round++) {
    log.info('[SmsSupervisor] LLM call round', {
      round,
      messageCount: messages.length,
      pendingWritesCount: pendingWrites.length,
      totalTokenEstimate: messages.reduce(
        (acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0),
        0
      ),
    });

    // Call LLM
    const llmStart = Date.now();
    const llmResponse = await callSupervisorLlm(messages, computeToken, userId);

    log.info('[SmsSupervisor] LLM response received', {
      round,
      reasoningLength: llmResponse.reasoning.length,
      toolCallCount: llmResponse.tool_calls.length,
      toolNames: llmResponse.tool_calls.map((tc) => tc.tool),
      reasoningPreview: llmResponse.reasoning.substring(0, 200),
      durationMs: Date.now() - llmStart,
    });

    const completionCall = llmResponse.tool_calls.find((tc) => tc.tool === 'attempt_completion');
    const realToolCalls = llmResponse.tool_calls.filter((tc) => tc.tool !== 'attempt_completion');
    const sendCalls = realToolCalls.filter((tc) => tc.tool === 'send_user_message');
    const dispatchCalls = realToolCalls.filter((tc) => tc.tool !== 'send_user_message');

    // Resolve reads/writes before user delivery. A same-round tool failure must
    // not allow an ungrounded success message to escape first.
    const toolResults: ToolResult[] = [];
    let terminalFailureReported = false;
    for (const toolCall of dispatchCalls) {
      const toolStart = Date.now();
      const result =
        toolCall.tool === 'get_environment'
          ? {
              tool: 'get_environment',
              success: true,
              result: await environment.refreshEnvironmentSnapshot(
                userId,
                inboundAlreadyPersisted ? mySeq : undefined
              ),
            }
          : await dispatchToolCall(toolCall, userId, pendingWrites, invocationContext);
      toolResults.push(result);
      allToolsExecuted.push(toolCall.tool);

      log.info('[SmsSupervisor] Tool dispatched', {
        round,
        tool: toolCall.tool,
        success: result.success,
        resultPreview: result.result.substring(0, 150),
        error: result.error,
        durationMs: Date.now() - toolStart,
      });
    }

    const dispatchFailures = toolResults.filter((result) => !result.success);
    if (sendCalls.length > 0 && dispatchFailures.length === 0) {
      const commitResults = await flushPendingWrites();
      const commitFailures = commitResults.filter((result) => !result.success);
      toolResults.push(...commitResults);
      if (commitFailures.length > 0) {
        const delivery = await deliverUserMessage(
          buildToolFailureMessage(commitFailures, 'commit')
        );
        toolResults.push(delivery);
        terminalFailureReported = delivery.success;
      } else {
        for (const toolCall of sendCalls) {
          const message = toolCall.arguments?.message;
          const result =
            typeof message === 'string' && message.trim() !== ''
              ? await deliverUserMessage(message)
              : {
                  tool: 'send_user_message',
                  success: false,
                  result: '',
                  error: 'message must be a non-empty string',
                };
          toolResults.push(result);
          allToolsExecuted.push(toolCall.tool);
        }
      }
    } else if (sendCalls.length > 0) {
      for (const toolCall of sendCalls) {
        toolResults.push({
          tool: toolCall.tool,
          success: false,
          result: '',
          error: 'Not sent because another tool in this response failed',
        });
        allToolsExecuted.push(toolCall.tool);
      }
    }

    const failedToolResults = toolResults.filter((result) => !result.success);

    // attempt_completion sends nothing. It is a valid stop signal only after
    // this run has successfully delivered at least one user message.
    if (completionCall) {
      if (terminalFailureReported) {
        completionAccepted = true;
        break;
      }
      if (sentMessages.length === 0 || failedToolResults.length > 0) {
        const completionFailure: ToolResult = {
          tool: 'attempt_completion',
          success: false,
          result: '',
          error:
            sentMessages.length === 0
              ? 'Rejected: this run has not successfully called send_user_message'
              : 'Rejected: at least one tool failed',
        };
        toolResults.push(completionFailure);
        log.warn('[SmsSupervisor] attempt_completion rejected', {
          round,
          sentMessageCount: sentMessages.length,
          failures: failedToolResults.map((result) => ({
            tool: result.tool,
            error: result.error,
          })),
        });

        const toolResultSummary = toolResults
          .map((r) => `[${r.tool}] ${r.success ? 'OK' : 'ERROR'}: ${r.result || r.error}`)
          .join('\n');

        messages.push({
          role: 'assistant',
          content: JSON.stringify({
            reasoning: llmResponse.reasoning,
            tool_calls: llmResponse.tool_calls,
          }),
        });
        messages.push({
          role: 'user',
          content: `Tool results:\n${toolResultSummary}\n[attempt_completion] ERROR: ${completionFailure.error}\n\nCorrect the failed call. Use send_user_message for anything the user should see. attempt_completion accepts no information and can only stop after a successful send_user_message in this run.`,
        });
        continue;
      }

      const commitResults = await flushPendingWrites();
      const commitFailures = commitResults.filter((result) => !result.success);
      if (commitFailures.length > 0) {
        const failureMessage = buildToolFailureMessage(commitFailures, 'commit');
        const delivery = await deliverUserMessage(failureMessage);
        toolResults.push(...commitResults, delivery);
        messages.push({
          role: 'assistant',
          content: JSON.stringify({
            reasoning: llmResponse.reasoning,
            tool_calls: llmResponse.tool_calls,
          }),
        });
        messages.push({
          role: 'user',
          content: `Tool results:\n${toolResults.map((r) => `[${r.tool}] ${r.success ? 'OK' : 'ERROR'}: ${r.result || r.error}`).join('\n')}\n\nThe write did not complete. Continue only if it can be corrected; otherwise call attempt_completion because the failure was sent to the user.`,
        });
        continue;
      }

      completionAccepted = true;
      log.info('[SmsSupervisor] attempt_completion accepted', {
        round,
        sentMessageCount: sentMessages.length,
        pendingWritesCount: pendingWrites.length,
      });
      break;
    }

    // No attempt_completion and no tool calls — nudge the LLM
    if (llmResponse.tool_calls.length === 0) {
      log.warn('[SmsSupervisor] No tool calls and no attempt_completion', { round });
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ reasoning: llmResponse.reasoning, tool_calls: [] }),
      });
      messages.push({
        role: 'user',
        content:
          'Use send_user_message for user-visible text. When the work is complete, call argument-free attempt_completion().',
      });
      continue;
    }

    // Append tool results to messages for next LLM call
    const toolResultSummary = toolResults
      .map((r) => `[${r.tool}] ${r.success ? 'OK' : 'ERROR'}: ${r.result || r.error}`)
      .join('\n');

    messages.push({
      role: 'assistant',
      content: JSON.stringify({
        reasoning: llmResponse.reasoning,
        tool_calls: llmResponse.tool_calls,
      }),
    });
    messages.push({
      role: 'user',
      content: `Tool results:\n${toolResultSummary}\n\nIncorporate these results. Use send_user_message for anything the user should see, continue working as needed, and call argument-free attempt_completion only when the run is complete.`,
    });

    if (round === environment.MAX_TOOL_ROUNDS - 1) {
      log.warn('[SmsSupervisor] Hit safety cap without attempt_completion');
    }
  }

  if (!completionAccepted && sentMessages.length === 0 && !abortSignal?.aborted) {
    await deliverUserMessage('Sorry, I had trouble processing that. Please try again.');
  }

  const committed = sentMessages.length > 0;
  const responseText = sentMessages.join('\n\n');

  log.info('[SmsSupervisor] === END ===', {
    userId,
    mySeq,
    committed,
    toolsExecuted: allToolsExecuted,
    completionAccepted,
    responseLength: responseText.length,
    totalDurationMs: Date.now() - overallStart,
  });

  return {
    responseText,
    committed,
    toolsExecuted: allToolsExecuted,
  };
}

// ============================================
// Compute Token Fetching
// ============================================

interface SupervisorComputeToken {
  type: 'claude' | 'gpt';
  accessToken: string;
  accountId?: string;
}

async function getComputeToken(userId: string): Promise<SupervisorComputeToken | null> {
  try {
    const computeToken = await fetchComputeTokenForUser(userId);
    if (computeToken) {
      log.info('[SmsSupervisor] Using compute token', {
        userId,
        type: computeToken.type,
        source: computeToken.source,
        poolTokenId: computeToken.poolTokenId,
      });
      return {
        type: computeToken.type,
        accessToken: computeToken.accessToken,
        accountId: computeToken.accountId,
      };
    }

    log.info('[SmsSupervisor] No compute token available, will use waterfall', { userId });
    return null;
  } catch (error) {
    log.warn('[SmsSupervisor] Failed to fetch compute token, falling back to waterfall', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ============================================
// LLM Call
// ============================================

async function callSupervisorLlm(
  messages: CompletionMessage[],
  computeToken: SupervisorComputeToken | null,
  userId: string
): Promise<SupervisorResponse> {
  const startTime = Date.now();
  const claudeToken = computeToken?.type === 'claude' ? computeToken.accessToken : null;
  const gptToken = computeToken?.type === 'gpt' ? computeToken.accessToken : null;
  const gptAccountId = computeToken?.type === 'gpt' ? computeToken.accountId : undefined;

  // Log the full request
  log.info('[SmsSupervisorLLM] Request', {
    model: SMS_SUPERVISOR_MODEL,
    messageCount: messages.length,
    hasClaudeToken: !!claudeToken,
    hasGptToken: !!gptToken,
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
  const stream = await createStreamingCompletion({
    model: SMS_SUPERVISOR_MODEL,
    messages,
    temperature: 0.3,
    response_model: SUPERVISOR_RESPONSE_MODEL,
    ...(claudeToken ? { claude_token: claudeToken } : {}),
    ...(gptToken ? { gpt_token: gptToken, gpt_account_id: gptAccountId } : {}),
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

  accumulatedContent = structuredOutput.finalText();

  // Fallback: structured-output JSON envelope arrived as content (Codex /
  // waterfall path, or claudeAuth when extraction didn't fit the schema shape).
  let parsed: SupervisorResponse;
  try {
    parsed = JSON.parse(accumulatedContent);
  } catch (error) {
    log.error('[SmsSupervisorLLM] Failed to parse response JSON', {
      error: error instanceof Error ? error.message : String(error),
      rawContent: accumulatedContent.substring(0, 500),
      contentLength: accumulatedContent.length,
    });

    // Never send raw garbage to the user — fall through to a friendly error.
    parsed = {
      reasoning: accumulatedReasoning || 'Failed to parse structured response',
      tool_calls: [
        {
          tool: 'send_user_message',
          arguments: { message: 'Sorry, something went wrong. Please try again.' },
        },
        { tool: 'attempt_completion', arguments: {} },
      ],
    };
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
