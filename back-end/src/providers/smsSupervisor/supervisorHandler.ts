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
import { CompletionMessage, ContentBlock, markCacheable } from '../rose';
import { sendSms } from '../smsQueue';
import { processInboundAttachments, type SurgeAttachment } from './inboundMedia';
import {
  commitPendingWrites,
  dispatchToolCall,
  PendingOp,
  type ToolCall,
  ToolResult,
} from './supervisorTools';
import { createLogger } from '../logger';
import { appendOutboundSms, fetchSessionMessagesSince } from './sessionStore';
import * as environment from './environmentMessages';
import { callSupervisorLlm, type SupervisorResponse } from './supervisorLlm';
import { callWithRetries, dispatchToolSafely } from './supervisorResilience';

const log = createLogger('SmsSupervisor');

// A single supervisor round's LLM call is retried this many times when the
// stream *throws* (network blip, peer-closed / [NO END] mid-stream, socket
// timeout, a single 429 slipping past Rose's internal provider race). Rose
// already races providers, so the residual throw class is transient; retrying
// with a short backoff turns "Sorry, something went wrong" into a real answer.
const SUPERVISOR_LLM_ATTEMPTS = 3;
const SUPERVISOR_LLM_RETRY_BASE_DELAY_MS = 400;

// How many rounds in a row the model may return zero tool calls before the run
// gives up on it. One empty round is usually a transient stream hiccup worth a
// re-ask; a model that has decided the thread needs nothing will keep declining,
// and nudging it ten times just buys ten LLM calls and ~40s of latency to reach
// the same place. Observed on the SMS bench: "Chill" burned all ten rounds and
// still ended in the fallback apology.
const MAX_CONSECUTIVE_EMPTY_ROUNDS = 2;
const TOOL_TRACE_RESULT_LIMIT = 2_000;

interface SupervisorToolTraceEntry {
  sequence: number;
  round: number;
  phase: 'dispatch' | 'commit' | 'completion';
  tool: string;
  arguments: Record<string, unknown>;
  success: boolean;
  result: string;
  resultTruncated: boolean;
  error?: string;
}

// User-facing last-resort line when a run genuinely cannot produce a reply after
// exhausting retries. Deliberately warmer + actionable than a bare "something
// went wrong", and delivered through the seq-gated deliverUserMessage path so it
// never double-sends or races a newer inbound.
export const SUPERVISOR_FALLBACK_MESSAGE =
  "Sorry — I hit a snag on my end and couldn't get to that one. Please send it again in a moment.";

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

export type { SupervisorResponse };

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
  const toolTrace: SupervisorToolTraceEntry[] = [];
  const pendingWrites: PendingOp[] = [];
  const sentMessages: string[] = [];
  let completionAccepted = false;
  let consecutiveEmptyRounds = 0;
  let inboundStoredForRun = inboundAlreadyPersisted;

  const recordToolTrace = (
    round: number,
    toolCall: ToolCall,
    result: ToolResult,
    phase: SupervisorToolTraceEntry['phase']
  ): void => {
    toolTrace.push({
      sequence: toolTrace.length,
      round,
      phase,
      tool: toolCall.tool,
      arguments: toolCall.arguments,
      success: result.success,
      result: result.result.substring(0, TOOL_TRACE_RESULT_LIMIT),
      resultTruncated: result.result.length > TOOL_TRACE_RESULT_LIMIT,
      ...(result.error === undefined ? {} : { error: result.error }),
    });
  };

  const runStillOwnsReply = async (): Promise<boolean> => {
    if (abortSignal?.aborted) return false;
    const current = await prisma.smsSession.findUnique({
      where: { userId },
      select: { lastInboundSeq: true },
    });
    if ((current?.lastInboundSeq ?? 0) > mySeq) return false;
    return commitGuard === undefined || (await commitGuard());
  };

  const flushPendingWrites = async (round: number): Promise<ToolResult[]> => {
    if (pendingWrites.length === 0) return [];
    return withCommitLock(userId, async () => {
      if (!(await runStillOwnsReply())) {
        const superseded: ToolResult = {
          tool: 'pending_writes',
          success: false,
          result: '',
          error: 'A newer inbound SMS superseded this run',
        };
        recordToolTrace(round, { tool: 'pending_writes', arguments: {} }, superseded, 'commit');
        return [superseded];
      }
      const queued = pendingWrites.splice(0, pendingWrites.length);
      const results = await commitPendingWrites(queued, userId);
      results.forEach((result, index) => {
        const operation = queued[index];
        recordToolTrace(
          round,
          {
            tool: operation?.kind ?? result.tool,
            arguments: (operation?.args as unknown as Record<string, unknown>) ?? {},
          },
          result,
          'commit'
        );
      });
      return results;
    });
  };

  const deliverUserMessage = async (message: string): Promise<ToolResult> =>
    withCommitLock(userId, async () => {
      // Blast-radius cap. Delivery is what the user actually experiences, so the
      // budget is enforced here rather than at the call sites — every path
      // (model-requested send, tool-failure report, terminal fallback) is bounded.
      if (sentMessages.length >= environment.MAX_USER_MESSAGES_PER_RUN) {
        log.warn('[SmsSupervisor] send_user_message refused: per-run budget exhausted', {
          userId,
          mySeq,
          sentMessageCount: sentMessages.length,
        });
        return {
          tool: 'send_user_message',
          success: false,
          result: '',
          error: environment.SEND_BUDGET_EXHAUSTED_ERROR,
        };
      }
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
      // The reply is now DELIVERED. Persistence is best-effort: a throw here must
      // NOT propagate, because an escaped throw would bubble to the webhook's
      // top-level catch and send SUPERVISOR_FALLBACK_MESSAGE on top of the reply
      // the user already received (a "real answer + spurious apology" double-send).
      // Record delivery regardless; log the persistence gap.
      let persisted = false;
      // Mark the inbound as attempted BEFORE awaiting: appendOutboundSms appends
      // the inbound unconditionally when passed, so if the DB commits but the
      // client observes an error, a later send in this run must NOT pass the
      // inbound again (which would duplicate it in the transcript). Attempted-once
      // is the idempotency guard; a truly-failed append loses the inbound line,
      // which is strictly better than corrupting the transcript with a duplicate.
      const inboundForThisSend = inboundStoredForRun ? undefined : inboundMessage;
      inboundStoredForRun = true;
      try {
        await appendOutboundSms(userId, message, smsResult.messageSid, inboundForThisSend);
        persisted = true;
      } catch (persistError) {
        log.error('[SmsSupervisor] Outbound SMS delivered but persistence failed', {
          userId,
          messageSid: smsResult.messageSid,
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
      }
      sentMessages.push(message);
      return {
        tool: 'send_user_message',
        success: true,
        result: persisted ? 'SMS sent and persisted' : 'SMS sent (persistence failed, logged)',
      };
    });

  // Newest thread entry already reflected in `messages`. Starts at run open so
  // the first poll picks up anything that landed after the context was composed.
  let threadWatermark = new Date().toISOString();

  for (let round = 0; round < environment.MAX_TOOL_ROUNDS; round++) {
    // Catch the model's view of the thread up to the user's phone. Anything
    // that landed since the last round — an agent announcing itself, a sibling
    // finishing — is replayed verbatim, in order, with the role it was stored
    // under. No wrapper and no commentary: the conversation should read exactly
    // as it does on the handset.
    try {
      const since = await fetchSessionMessagesSince(userId, threadWatermark);
      if (since.length > 0) {
        threadWatermark = since[since.length - 1].timestamp;
        for (const entry of since) {
          messages.push({ role: entry.role, content: entry.content });
        }
        log.info('[SmsSupervisor] Caught thread up', { userId, round, count: since.length });
      }
    } catch (error) {
      // A failed poll must not kill the run — worst case is the pre-existing
      // blind spot for this round.
      log.warn('[SmsSupervisor] Thread catch-up poll failed', {
        userId,
        round,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    log.info('[SmsSupervisor] LLM call round', {
      round,
      messageCount: messages.length,
      pendingWritesCount: pendingWrites.length,
      totalTokenEstimate: messages.reduce(
        (acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0),
        0
      ),
    });

    // Call LLM. A thrown stream error (peer-closed mid-stream, socket timeout,
    // a stray 429) is retried with backoff INSIDE the round so a transient blip
    // never escapes to the webhook's generic "something went wrong". If every
    // retry throws, the LLM is genuinely unreachable this round — stop hammering
    // it across all remaining rounds and fall through to the graceful terminal
    // net below (which delivers SUPERVISOR_FALLBACK_MESSAGE only if nothing was
    // sent yet, seq-gated + persisted).
    const llmStart = Date.now();
    let llmResponse: SupervisorResponse;
    try {
      llmResponse = await callWithRetries(() => callSupervisorLlm(messages, userId), {
        attempts: SUPERVISOR_LLM_ATTEMPTS,
        baseDelayMs: SUPERVISOR_LLM_RETRY_BASE_DELAY_MS,
        signal: abortSignal,
        onRetry: (attempt, error) =>
          log.warn('[SmsSupervisor] LLM call threw; retrying round', {
            round,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          }),
      });
    } catch (error) {
      log.error('[SmsSupervisor] LLM call failed after retries; degrading gracefully', {
        round,
        attempts: SUPERVISOR_LLM_ATTEMPTS,
        alreadySent: sentMessages.length,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }

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
      // dispatchToolSafely converts a THROWN tool/environment error into a
      // failure result so it feeds back to the model instead of escaping the
      // loop into the generic top-level apology.
      const result = await dispatchToolSafely(toolCall.tool, async () =>
        toolCall.tool === 'get_environment'
          ? {
              tool: 'get_environment',
              success: true,
              result: await environment.refreshEnvironmentSnapshot(
                userId,
                inboundAlreadyPersisted ? mySeq : undefined
              ),
            }
          : await dispatchToolCall(toolCall, userId, pendingWrites, invocationContext)
      );
      toolResults.push(result);
      allToolsExecuted.push(toolCall.tool);
      recordToolTrace(round, toolCall, result, 'dispatch');

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
      const commitResults = await flushPendingWrites(round);
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
          recordToolTrace(round, toolCall, result, 'dispatch');
        }
      }
    } else if (sendCalls.length > 0) {
      for (const toolCall of sendCalls) {
        const result: ToolResult = {
          tool: toolCall.tool,
          success: false,
          result: '',
          error: 'Not sent because another tool in this response failed',
        };
        toolResults.push(result);
        allToolsExecuted.push(toolCall.tool);
        recordToolTrace(round, toolCall, result, 'dispatch');
      }
    }

    const failedToolResults = toolResults.filter((result) => !result.success);
    // A budget refusal is the loop telling the model to stop, not a broken tool.
    // Counting it as a failure would reject the very attempt_completion the
    // refusal asked for, and spin the run to the round cap for nothing.
    const blockingFailures = failedToolResults.filter(
      (result) => result.error !== environment.SEND_BUDGET_EXHAUSTED_ERROR
    );

    // attempt_completion sends nothing. It is a valid stop signal only after
    // this run has successfully delivered at least one user message.
    if (completionCall) {
      if (terminalFailureReported) {
        completionAccepted = true;
        recordToolTrace(
          round,
          completionCall,
          {
            tool: 'attempt_completion',
            success: true,
            result: 'Completion accepted after a terminal tool failure was reported to the user',
          },
          'completion'
        );
        break;
      }
      if (sentMessages.length === 0 || blockingFailures.length > 0) {
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
        recordToolTrace(round, completionCall, completionFailure, 'completion');
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

        messages.push(
          ...environment.buildToolFeedbackMessages({
            round,
            assistantPayload: JSON.stringify({
              reasoning: llmResponse.reasoning,
              tool_calls: llmResponse.tool_calls,
            }),
            toolResultSummary: `Tool results:\n${toolResultSummary}\n[attempt_completion] ERROR: ${completionFailure.error}`,
            guidance:
              'Correct the failed call. Use send_user_message for anything the user should see. attempt_completion accepts no information and can only stop after a successful send_user_message in this run.',
          })
        );
        continue;
      }

      const commitResults = await flushPendingWrites(round);
      const commitFailures = commitResults.filter((result) => !result.success);
      if (commitFailures.length > 0) {
        const failureMessage = buildToolFailureMessage(commitFailures, 'commit');
        const delivery = await deliverUserMessage(failureMessage);
        toolResults.push(...commitResults, delivery);
        recordToolTrace(
          round,
          completionCall,
          {
            tool: 'attempt_completion',
            success: false,
            result: '',
            error: 'Rejected: at least one pending write failed to commit',
          },
          'completion'
        );
        messages.push(
          ...environment.buildToolFeedbackMessages({
            round,
            assistantPayload: JSON.stringify({
              reasoning: llmResponse.reasoning,
              tool_calls: llmResponse.tool_calls,
            }),
            toolResultSummary: `Tool results:\n${toolResults.map((r) => `[${r.tool}] ${r.success ? 'OK' : 'ERROR'}: ${r.result || r.error}`).join('\n')}`,
            guidance:
              'The write did not complete. Continue only if it can be corrected; otherwise call attempt_completion because the failure was sent to the user.',
          })
        );
        continue;
      }

      completionAccepted = true;
      recordToolTrace(
        round,
        completionCall,
        { tool: 'attempt_completion', success: true, result: 'Completion accepted' },
        'completion'
      );
      log.info('[SmsSupervisor] attempt_completion accepted', {
        round,
        sentMessageCount: sentMessages.length,
        pendingWritesCount: pendingWrites.length,
      });
      break;
    }

    // No attempt_completion and no tool calls. Two different situations wear
    // this shape: a transient empty/garbled stream (retry is right), and a model
    // that has decided the thread needs nothing more (retrying is pure waste —
    // it will keep declining). Bound the retries so the second case costs two
    // LLM calls instead of ten, and make the nudge state the actual requirement
    // rather than restating the tool menu.
    if (llmResponse.tool_calls.length === 0) {
      consecutiveEmptyRounds += 1;
      log.warn('[SmsSupervisor] No tool calls and no attempt_completion', {
        round,
        consecutiveEmptyRounds,
      });
      if (consecutiveEmptyRounds >= MAX_CONSECUTIVE_EMPTY_ROUNDS) {
        log.warn('[SmsSupervisor] Ending run early: model kept returning no tool calls', {
          round,
          consecutiveEmptyRounds,
          sentMessageCount: sentMessages.length,
        });
        break;
      }
      messages.push(
        ...environment.buildToolFeedbackMessages({
          round,
          assistantPayload: JSON.stringify({
            reasoning: llmResponse.reasoning,
            tool_calls: [],
          }),
          toolResultSummary: '',
          guidance:
            sentMessages.length === 0
              ? 'That response contained no tool calls, so nothing reached the user. They texted you and are waiting on an answer; staying silent is not an option this run. Call send_user_message once with a short reply in your own words, then attempt_completion.'
              : 'That response contained no tool calls. This run has already replied, so call argument-free attempt_completion now.',
        })
      );
      continue;
    }
    consecutiveEmptyRounds = 0;

    // Append tool results to messages for next LLM call
    const toolResultSummary = toolResults
      .map((r) => `[${r.tool}] ${r.success ? 'OK' : 'ERROR'}: ${r.result || r.error}`)
      .join('\n');

    messages.push(
      ...environment.buildToolFeedbackMessages({
        round,
        assistantPayload: JSON.stringify({
          reasoning: llmResponse.reasoning,
          tool_calls: llmResponse.tool_calls,
        }),
        toolResultSummary: `Tool results:\n${toolResultSummary}`,
        guidance:
          'Incorporate these results. Use send_user_message only for text the user still needs, and call argument-free attempt_completion as soon as the run is complete.',
      })
    );

    // Budget spent: nothing further this run can reach the user, so keep going
    // only long enough to commit queued writes, then stop. Every extra round
    // past this point is pure cost with no observable effect.
    if (sentMessages.length >= environment.MAX_USER_MESSAGES_PER_RUN) {
      const budgetCommitResults = await flushPendingWrites(round);
      log.warn('[SmsSupervisor] Ending run early: per-run SMS budget exhausted', {
        round,
        sentMessageCount: sentMessages.length,
        committedWrites: budgetCommitResults.length,
      });
      break;
    }

    if (round === environment.MAX_TOOL_ROUNDS - 1) {
      log.warn('[SmsSupervisor] Hit safety cap without attempt_completion');
    }
  }

  if (!completionAccepted && sentMessages.length === 0 && !abortSignal?.aborted) {
    await deliverUserMessage(SUPERVISOR_FALLBACK_MESSAGE);
  }

  const committed = sentMessages.length > 0;
  const responseText = sentMessages.join('\n\n');

  // Stable machine-readable audit consumed by the SMS benchmark runner. Keep
  // the trace as a JSON string because the dev logger otherwise renders arrays
  // as "[object Object]". The report can now prove whether web_search happened,
  // with which arguments, and what result preceded an irreversible action.
  log.info('[SmsSupervisor] TOOL_TRACE', {
    userId,
    mySeq,
    toolTrace: JSON.stringify(toolTrace),
  });

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
