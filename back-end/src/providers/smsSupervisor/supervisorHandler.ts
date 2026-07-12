/**
 * SMS Supervisor Handler
 *
 * Main orchestrator for the SMS supervisor agent. Receives inbound SMS,
 * builds context, calls LLM in a tool loop until attempt_completion,
 * and sends the final response SMS.
 *
 * Loop pattern:
 *   1. Call LLM → get { reasoning, tool_calls }
 *   2. If attempt_completion in tool_calls → extract message, exit loop
 *   3. Execute other tools, append results, loop again
 *
 * Session persistence: only the user's inbound message and the assistant's
 * final attempt_completion message are saved. Intermediate tool rounds are ephemeral.
 *
 * Logs extensively at every boundary: DB reads, LLM calls, tool executions, SMS sends.
 */

import { prisma } from '../database';
import { createStreamingCompletion, CompletionMessage, ContentBlock, markCacheable } from '../rose';
import { StructuredOutputAccumulator } from '../rose/structuredOutput';
import { sendSms } from '../smsQueue';
import { buildSmsContext } from './contextBuilder';
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
import { SmsSupervisorResponseSchema, SUPERVISOR_RESPONSE_MODEL } from './schema';

const log = createLogger('SmsSupervisor');

const SMS_SUPERVISOR_MODEL = 'rose-labs/rose-1-lite';
const MAX_TOOL_ROUNDS = 10; // Safety cap

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

interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface SmsSupervisorResult {
  responseText: string;
  toolsExecuted: string[];
  /** True iff the run reached the commit gate and sent/persisted a user-facing reply. */
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
  attachments?: SurgeAttachment[];
  abortSignal?: AbortSignal;
  commitGuard?: () => Promise<boolean>;
}): Promise<SmsSupervisorResult> {
  const { userId, phoneNumber, inboundMessage, mySeq, abortSignal, commitGuard } = config;
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

  // 1. Load or create SMS session
  const session = await loadOrCreateSession(userId);

  log.info('[SmsSupervisor] Session loaded', {
    userId,
    sessionId: session.id,
    existingMessageCount: session.messages.length,
    isNew: session.isNew,
  });

  // 2. Build context (system prompt + session history)
  const contextStart = Date.now();
  const { systemPrompt, contextUserMessage, sessionHistory } = await buildSmsContext(userId);

  log.info('[SmsSupervisor] Context built', {
    userId,
    systemPromptLength: systemPrompt.length,
    contextUserMessageLength: contextUserMessage.length,
    sessionHistoryLength: sessionHistory.length,
    durationMs: Date.now() - contextStart,
  });

  // 3. Fetch Claude token for direct Anthropic passthrough
  const computeToken = await getComputeToken(userId);

  // 4. Build messages array for LLM. The volatile per-SMS state is injected as
  // a `user`-role message right before the inbound user message — keeping it
  // out of the system prompt is what lets Anthropic prompt-caching reuse the
  // static system prefix across SMSes within the 5-min ephemeral window.
  //
  // `markCacheable` makes the cache boundary explicit: the entire system
  // prompt is the cacheable static prefix. See providers/rose/cache.ts.
  const messages: CompletionMessage[] = [
    markCacheable(systemPrompt),
    ...sessionHistory,
    { role: 'user', content: contextUserMessage },
    { role: 'user', content: inboundContent },
  ];

  // 5. LLM call loop — loop until attempt_completion or safety cap.
  // Write tools queue into `pendingWrites`; only attempt_completion flushes
  // them, and only after the commit gate confirms no newer SMS arrived.
  let finalResponse = '';
  const allToolsExecuted: string[] = [];
  const pendingWrites: PendingOp[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
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

    // Dispatch real tool calls: read tools run inline, write tools queue.
    const toolResults: ToolResult[] = [];
    for (const toolCall of realToolCalls) {
      const toolStart = Date.now();
      const result = await dispatchToolCall(toolCall, userId, pendingWrites);
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

    const failedToolResults = toolResults.filter((result) => !result.success);

    // attempt_completion ends the run; the gated commit happens below.
    if (completionCall) {
      if (failedToolResults.length > 0) {
        log.warn('[SmsSupervisor] attempt_completion ignored because tool dispatch failed', {
          round,
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
          content: `Tool results:\n${toolResultSummary}\n\nAt least one tool failed. Do not claim the action completed. Correct the tool call, use another tool, or call attempt_completion with a failure message for the user.`,
        });
        continue;
      }

      const completionMessage = completionCall.arguments?.message;
      finalResponse = typeof completionMessage === 'string' ? completionMessage : '';
      log.info('[SmsSupervisor] attempt_completion received', {
        round,
        responseLength: finalResponse.length,
        responsePreview: finalResponse.substring(0, 200),
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
          'You must call attempt_completion with your message to send the SMS. Please do so now.',
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
      content: `Tool results:\n${toolResultSummary}\n\nIncorporate these results and either use more tools or call attempt_completion to send your SMS response.`,
    });

    // Safety cap: if the model never calls attempt_completion, the post-loop
    // gate still runs with a fallback message so we either send-or-discard
    // — never leave the user hanging silently.
    if (round === MAX_TOOL_ROUNDS - 1 && !finalResponse) {
      finalResponse = 'Sorry, I had trouble processing that. Please try again.';
      log.warn('[SmsSupervisor] Hit safety cap without attempt_completion');
    }
  }

  // 6. Pre-commit abort check — /clear or similar cancellation supersedes both
  // the SMS and the queued writes.
  if (abortSignal?.aborted) {
    log.info('[SmsSupervisor] Aborted before commit (session cleared)', {
      userId,
      responseLength: finalResponse.length,
      pendingWritesCount: pendingWrites.length,
    });
    return { responseText: '', toolsExecuted: allToolsExecuted, committed: false };
  }

  if (!finalResponse) {
    finalResponse = "Sorry, I couldn't process that. Try again or text a task to get started.";
  }

  // 7. Commit gate: under the per-user lock, re-read lastInboundSeq. If a
  // newer SMS landed during our run, discard everything and stay silent —
  // the newer run is responsible for the user-facing reply.
  const committed = await withCommitLock(userId, async () => {
    const current = await prisma.smsSession.findUnique({
      where: { userId },
      select: { lastInboundSeq: true },
    });
    const currentSeq = current?.lastInboundSeq ?? 0;

    if (currentSeq > mySeq) {
      log.info('[SmsSupervisor] Seq advanced — discarding pendingWrites + skipping SMS', {
        userId,
        mySeq,
        currentSeq,
        pendingWritesCount: pendingWrites.length,
        finalResponseLength: finalResponse.length,
      });
      return false;
    }

    if (commitGuard && !(await commitGuard())) {
      log.info('[SmsSupervisor] Commit guard denied SMS response and pending writes', {
        userId,
        mySeq,
        pendingWritesCount: pendingWrites.length,
        finalResponseLength: finalResponse.length,
      });
      return false;
    }

    // Flush queued writes in order. Each commitX function is idempotent enough
    // for v1 (start_new_agent dedupes on PK; kill is a no-op on absence;
    // increase_budget and reply_to_agent are guarded by this commit-lock).
    if (pendingWrites.length > 0) {
      const commitStart = Date.now();
      const commitResults = await commitPendingWrites(pendingWrites, userId);
      const failedCommitResults = commitResults.filter((result) => !result.success);
      log.info('[SmsSupervisor] Pending writes committed', {
        userId,
        count: pendingWrites.length,
        successes: commitResults.filter((r) => r.success).length,
        failures: failedCommitResults.length,
        durationMs: Date.now() - commitStart,
      });
      if (failedCommitResults.length > 0) {
        log.error('[SmsSupervisor] Pending write commit failures will be reported to user', {
          userId,
          failures: failedCommitResults.map((result) => ({
            tool: result.tool,
            error: result.error,
          })),
        });
        finalResponse = buildToolFailureMessage(failedCommitResults, 'commit');
      }
    }

    // Send the SMS.
    const smsStart = Date.now();
    const smsResult = await sendSms(phoneNumber, finalResponse);
    log.info('[SmsSupervisor] SMS sent', {
      userId,
      phone: phoneNumber.substring(0, 7) + '****',
      responseLength: finalResponse.length,
      responsePreview: finalResponse.substring(0, 200),
      success: smsResult.success,
      messageSid: smsResult.messageSid,
      error: smsResult.error,
      durationMs: Date.now() - smsStart,
    });

    // Persist the user→assistant turn pair (no tool transcript). Session
    // content is text-only: voice notes persist as their transcript lines,
    // photos as a marker so later turns know an image was shared.
    const persistedUserContent =
      media.imageBlocks.length > 0
        ? [inboundText, `[${media.imageBlocks.length} photo(s) attached]`]
            .filter((s) => s !== '')
            .join('\n\n')
        : inboundText;
    session.messages.push({
      role: 'user',
      content: persistedUserContent,
      timestamp: new Date().toISOString(),
    });
    session.messages.push({
      role: 'assistant',
      content: finalResponse,
      timestamp: new Date().toISOString(),
    });
    await saveSession(userId, session.messages);

    return true;
  });

  log.info('[SmsSupervisor] === END ===', {
    userId,
    mySeq,
    committed,
    toolsExecuted: allToolsExecuted,
    responseLength: finalResponse.length,
    sessionMessageCount: session.messages.length,
    totalDurationMs: Date.now() - overallStart,
  });

  return {
    responseText: committed ? finalResponse : '',
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
          tool: 'attempt_completion',
          arguments: { message: 'Sorry, something went wrong. Please try again.' },
        },
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

/**
 * Per-user fixture overrides set by blackbox tests via
 * `POST /api/test/sms-supervisor-fixture`. When present for a user, takes
 * precedence over `BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON`. Lets each test
 * inject its own LLM response without rebooting the backend.
 *
 * The sentinel `BYPASS_FIXTURE_REAL_LLM` registers a user as opted-out of
 * BOTH the per-user override and the env-var fallback — that user's run hits
 * the real Rose stack (claudeAuth + native tool_use + waterfall). Used by the
 * real-LLM smoke test to exercise the full WS-3 pipeline.
 */
const supervisorFixtureOverrides = new Map<string, string>();
export const BYPASS_FIXTURE_REAL_LLM = '__bypass_real_llm__';

export function setSupervisorFixtureOverride(userId: string, fixture: string): void {
  supervisorFixtureOverrides.set(userId, fixture);
}

export function clearSupervisorFixtureOverride(userId: string): void {
  supervisorFixtureOverrides.delete(userId);
}

interface LoadedFixture {
  response: SupervisorResponse;
  delayMs: number;
}

function loadBlackboxSupervisorResponseFixture(userId: string): LoadedFixture | null {
  if (process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND !== '1') {
    return null;
  }

  const override = supervisorFixtureOverrides.get(userId);
  if (override === BYPASS_FIXTURE_REAL_LLM) {
    // Per-user opt-out: skip both override and env fallback; run hits real LLM.
    return null;
  }
  const raw = override ?? process.env.BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON;
  if (!raw) {
    return null;
  }

  // `delay_ms` is an out-of-band fixture-control field; strip it before
  // validating the rest against SmsSupervisorResponseSchema so the schema
  // stays in sync with what production model responses look like.
  const rawObj = JSON.parse(raw) as Record<string, unknown>;
  const delayMs =
    typeof rawObj.delay_ms === 'number' && Number.isFinite(rawObj.delay_ms) && rawObj.delay_ms >= 0
      ? rawObj.delay_ms
      : 0;
  delete rawObj.delay_ms;

  const parsed = SmsSupervisorResponseSchema.parse(rawObj);
  return {
    response: { reasoning: parsed.reasoning, tool_calls: parsed.tool_calls },
    delayMs,
  };
}

// ============================================
// Session Management
// ============================================

interface SessionData {
  id: string;
  messages: SessionMessage[];
  isNew: boolean;
}

async function loadOrCreateSession(userId: string): Promise<SessionData> {
  const session = await prisma.smsSession.upsert({
    where: { userId },
    update: {},
    create: { userId, messages: JSON.stringify([]) },
  });
  const messages = parseSessionMessages(session.messages);

  return { id: session.id, messages, isNew: messages.length === 0 };
}

function parseSessionMessages(raw: unknown): SessionMessage[] {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    // Filter: a bad row (missing role / non-string content / missing timestamp)
    // would flow straight into the next Rose request and fail the LLM call.
    return arr.filter(
      (item): item is SessionMessage =>
        typeof item === 'object' &&
        item !== null &&
        ((item as Record<string, unknown>).role === 'user' ||
          (item as Record<string, unknown>).role === 'assistant') &&
        typeof (item as Record<string, unknown>).content === 'string' &&
        typeof (item as Record<string, unknown>).timestamp === 'string'
    );
  } catch {
    return [];
  }
}

async function saveSession(userId: string, messages: SessionMessage[]): Promise<void> {
  await prisma.smsSession.upsert({
    where: { userId },
    update: { messages: JSON.stringify(messages) },
    create: { userId, messages: JSON.stringify(messages) },
  });

  log.info('[SmsSession] Saved', {
    userId,
    messageCount: messages.length,
  });
}
