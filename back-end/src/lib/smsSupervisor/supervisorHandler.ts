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

import { prisma } from '../prisma';
import {
  createStreamingCompletion,
  CompletionMessage,
  CompletionChunk,
} from '../chat/supabaseCompletions';
import { sendSms } from '../smsQueue';
import { buildSmsContext } from './contextBuilder';
import { TOOL_SCHEMAS, executeToolCall, ToolCall, ToolResult } from './supervisorTools';
import { fetchClaudeCodeAccessToken, fetchPoolToken } from '../claudeCredentials';

const SMS_SUPERVISOR_MODEL = 'rose-labs/rose-1-lite';
const MAX_TOOL_ROUNDS = 10; // Safety cap

// JSON schema for structured LLM output (no response field — must use attempt_completion)
const SUPERVISOR_RESPONSE_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'sms_supervisor_response',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        reasoning: {
          type: 'string',
          description: 'Internal thought process (not shown to user)',
        },
        tool_calls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              arguments: { type: 'object' },
            },
            required: ['tool', 'arguments'],
            additionalProperties: false,
          },
          description: 'Tool calls to execute. Include attempt_completion when ready to respond.',
        },
      },
      required: ['reasoning', 'tool_calls'],
      additionalProperties: false,
    },
  },
};

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
}

/**
 * Handle an inbound SMS message through the supervisor agent.
 */
export async function handleSmsSupervisorMessage(config: {
  userId: string;
  phoneNumber: string;
  inboundMessage: string;
  abortSignal?: AbortSignal;
}): Promise<SmsSupervisorResult> {
  const { userId, phoneNumber, inboundMessage, abortSignal } = config;
  const overallStart = Date.now();

  console.log('[SMS Supervisor] === START ===', {
    userId,
    phone: phoneNumber.substring(0, 7) + '****',
    messageLength: inboundMessage.length,
    messagePreview: inboundMessage.substring(0, 100),
  });

  // 1. Load or create SMS session
  const session = await loadOrCreateSession(userId);

  console.log('[SMS Supervisor] Session loaded', {
    userId,
    sessionId: session.id,
    existingMessageCount: session.messages.length,
    isNew: session.isNew,
  });

  // 2. Build context (system prompt + session history)
  const contextStart = Date.now();
  const { systemPrompt, sessionHistory } = await buildSmsContext(userId);

  console.log('[SMS Supervisor] Context built', {
    userId,
    systemPromptLength: systemPrompt.length,
    sessionHistoryLength: sessionHistory.length,
    durationMs: Date.now() - contextStart,
  });

  // 3. Fetch Claude token for direct Anthropic passthrough
  const claudeToken = await getClaudeToken(userId);

  // 4. Build messages array for LLM
  const messages: CompletionMessage[] = [
    { role: 'system', content: systemPrompt },
    ...sessionHistory,
    { role: 'user', content: inboundMessage },
  ];

  // 5. LLM call loop — loop until attempt_completion or safety cap
  let finalResponse = '';
  const allToolsExecuted: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    console.log('[SMS Supervisor] LLM call round', {
      round,
      messageCount: messages.length,
      totalTokenEstimate: messages.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0),
    });

    // Call LLM
    const llmStart = Date.now();
    const llmResponse = await callSupervisorLlm(messages, claudeToken);

    console.log('[SMS Supervisor] LLM response received', {
      round,
      reasoningLength: llmResponse.reasoning.length,
      toolCallCount: llmResponse.tool_calls.length,
      toolNames: llmResponse.tool_calls.map(tc => tc.tool),
      reasoningPreview: llmResponse.reasoning.substring(0, 200),
      durationMs: Date.now() - llmStart,
    });

    // Check for attempt_completion in tool_calls
    const completionCall = llmResponse.tool_calls.find(tc => tc.tool === 'attempt_completion');

    // Separate real tool calls from attempt_completion
    const realToolCalls = llmResponse.tool_calls.filter(tc => tc.tool !== 'attempt_completion');

    // Execute real tool calls (if any)
    const toolResults: ToolResult[] = [];
    for (const toolCall of realToolCalls) {
      const toolStart = Date.now();
      const result = await executeToolCall(toolCall, userId);
      toolResults.push(result);
      allToolsExecuted.push(toolCall.tool);

      console.log('[SMS Supervisor] Tool executed', {
        round,
        tool: toolCall.tool,
        success: result.success,
        resultPreview: result.result.substring(0, 150),
        error: result.error,
        durationMs: Date.now() - toolStart,
      });
    }

    // If attempt_completion was called, extract the message and exit
    if (completionCall) {
      finalResponse = completionCall.arguments?.message || '';
      console.log('[SMS Supervisor] attempt_completion received', {
        round,
        responseLength: finalResponse.length,
        responsePreview: finalResponse.substring(0, 200),
      });
      break;
    }

    // No attempt_completion and no tool calls — nudge the LLM
    if (llmResponse.tool_calls.length === 0) {
      console.warn('[SMS Supervisor] No tool calls and no attempt_completion', { round });
      messages.push({
        role: 'assistant',
        content: JSON.stringify({
          reasoning: llmResponse.reasoning,
          tool_calls: [],
        }),
      });
      messages.push({
        role: 'user',
        content: 'You must call attempt_completion with your message to send the SMS. Please do so now.',
      });
      continue;
    }

    // Append tool results to messages for next LLM call
    const toolResultSummary = toolResults
      .map(r => `[${r.tool}] ${r.success ? 'OK' : 'ERROR'}: ${r.result || r.error}`)
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

    // On last round safety cap, force a response
    if (round === MAX_TOOL_ROUNDS - 1 && !finalResponse) {
      finalResponse = 'Sorry, I had trouble processing that. Please try again.';
      console.warn('[SMS Supervisor] Hit safety cap without attempt_completion');
    }
  }

  // 6. Check if session was cleared while we were processing
  if (abortSignal?.aborted) {
    console.log('[SMS Supervisor] Aborted before sending SMS (session cleared)', {
      userId,
      responseLength: finalResponse.length,
    });
    return { responseText: '', toolsExecuted: allToolsExecuted };
  }

  // 7. Send response SMS
  if (finalResponse) {
    const smsStart = Date.now();
    const smsResult = await sendSms(phoneNumber, finalResponse);

    console.log('[SMS Supervisor] SMS sent', {
      userId,
      phone: phoneNumber.substring(0, 7) + '****',
      responseLength: finalResponse.length,
      responsePreview: finalResponse.substring(0, 200),
      success: smsResult.success,
      messageSid: smsResult.messageSid,
      error: smsResult.error,
      durationMs: Date.now() - smsStart,
    });
  } else {
    console.warn('[SMS Supervisor] No response to send', { userId });
    finalResponse = "Sorry, I couldn't process that. Try again or text a task to get started.";
    await sendSms(phoneNumber, finalResponse);
  }

  // 8. Save session — only the user's inbound message and assistant's final response
  session.messages.push({
    role: 'user',
    content: inboundMessage,
    timestamp: new Date().toISOString(),
  });
  session.messages.push({
    role: 'assistant',
    content: finalResponse,
    timestamp: new Date().toISOString(),
  });

  await saveSession(userId, session.messages);

  console.log('[SMS Supervisor] === END ===', {
    userId,
    toolsExecuted: allToolsExecuted,
    responseLength: finalResponse.length,
    sessionMessageCount: session.messages.length,
    totalDurationMs: Date.now() - overallStart,
  });

  return {
    responseText: finalResponse,
    toolsExecuted: allToolsExecuted,
  };
}

// ============================================
// Claude Token Fetching
// ============================================

async function getClaudeToken(userId: string): Promise<string | null> {
  try {
    // Try user's own token first
    const userToken = await fetchClaudeCodeAccessToken(userId);
    if (userToken) {
      console.log('[SMS Supervisor] Using user Claude token', { userId });
      return userToken;
    }

    // Fall back to pool
    const poolResult = await fetchPoolToken();
    if (poolResult) {
      console.log('[SMS Supervisor] Using pool Claude token', { userId, poolTokenId: poolResult.poolTokenId });
      return poolResult.accessToken;
    }

    console.log('[SMS Supervisor] No Claude token available, will use racing', { userId });
    return null;
  } catch (error) {
    console.warn('[SMS Supervisor] Failed to fetch Claude token, falling back to racing', {
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
  claudeToken: string | null
): Promise<SupervisorResponse> {
  const startTime = Date.now();

  // Log the full request
  console.log('[SMS Supervisor LLM] Request', {
    model: SMS_SUPERVISOR_MODEL,
    messageCount: messages.length,
    hasClaudeToken: !!claudeToken,
    systemPromptLength: messages[0]?.content
      ? (typeof messages[0].content === 'string' ? messages[0].content.length : 0)
      : 0,
    messages: messages.map((m, i) => ({
      index: i,
      role: m.role,
      contentLength: typeof m.content === 'string' ? m.content.length : 0,
      contentPreview: typeof m.content === 'string' ? m.content.substring(0, 100) : '[non-string]',
    })),
  });

  // Consume streaming response fully (no FE broadcast needed)
  const stream = await createStreamingCompletion({
    model: SMS_SUPERVISOR_MODEL,
    messages,
    temperature: 0.3,
    response_format: SUPERVISOR_RESPONSE_SCHEMA,
    ...(claudeToken ? { claude_token: claudeToken } : {}),
  });

  let accumulatedContent = '';
  let accumulatedReasoning = '';
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
  let actualModel = '';
  let poolName = '';

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      accumulatedContent += choice.delta.content;
    }
    if (choice?.delta?.reasoning) {
      accumulatedReasoning += choice.delta.reasoning;
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

  console.log('[SMS Supervisor LLM] Response stream consumed', {
    contentLength: accumulatedContent.length,
    reasoningLength: accumulatedReasoning.length,
    actualModel,
    poolName,
    usage,
    durationMs: Date.now() - startTime,
  });

  // Parse the structured JSON response
  let parsed: SupervisorResponse;
  try {
    parsed = JSON.parse(accumulatedContent);
  } catch (error) {
    console.error('[SMS Supervisor LLM] Failed to parse response JSON', {
      error: error instanceof Error ? error.message : String(error),
      rawContent: accumulatedContent.substring(0, 500),
      contentLength: accumulatedContent.length,
    });

    // Fallback: send a user-friendly error (never send raw JSON/garbage to the user)
    parsed = {
      reasoning: accumulatedReasoning || 'Failed to parse structured response',
      tool_calls: [{
        tool: 'attempt_completion',
        arguments: { message: "Sorry, something went wrong. Please try again." },
      }],
    };
  }

  // Log the full parsed response
  console.log('[SMS Supervisor LLM] Parsed response', {
    reasoning: parsed.reasoning.substring(0, 300),
    toolCallCount: parsed.tool_calls?.length || 0,
    toolCalls: parsed.tool_calls?.map(tc => ({
      tool: tc.tool,
      args: JSON.stringify(tc.arguments).substring(0, 100),
    })),
  });

  return {
    reasoning: parsed.reasoning || '',
    tool_calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [],
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
  const existing = await prisma.smsSession.findUnique({
    where: { userId },
  });

  if (existing) {
    const messages = parseSessionMessages(existing.messages);
    return { id: existing.id, messages, isNew: false };
  }

  // Create new session
  const session = await prisma.smsSession.create({
    data: { userId, messages: JSON.stringify([]) },
  });

  console.log('[SMS Session] Created new session', {
    userId,
    sessionId: session.id,
  });

  return { id: session.id, messages: [], isNew: true };
}

function parseSessionMessages(raw: any): SessionMessage[] {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr;
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

  console.log('[SMS Session] Saved', {
    userId,
    messageCount: messages.length,
  });
}
