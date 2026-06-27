/**
 * Chat Handler - Core orchestrator for chat mode.
 * Implements the fixed LLM call sequence based on Manus architecture:
 *
 * - direct_answer: Router → Generator (2 LLM calls)
 * - web_search: Router → Search → Generator (2 LLM calls + search)
 * - agent_start_task: Router only → start Temporal (1 LLM call, exit)
 *
 * Both Router and Generator stream their reasoning as ASSISTANT_STREAM (thinking).
 * Only the Generator's response field is saved as the true ASSISTANT message (INSERT).
 */

import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../database';
import { startAgentWorkflow } from '../temporal';
import { createMessage } from '../messages';
import { callRouterLlm, RouterDecision, type ChatLlmUsage } from './routerLlm';
import { callGeneratorLlm } from './generatorLlm';
import { executeWebSearch } from './chatTools';
import { agentFastMode } from '../fastCacheStore';
import { callWithChatComputeRotation, fetchChatComputeAuth } from './computeRotation';
import {
  broadcastToolEvent,
  broadcastAgentModeStarted,
  generateStreamId,
} from './supabaseBroadcast';
import { CLOUD_AGENT_TOOL_NAME, CREATING_CLOUD_AGENT_TITLE } from './cloudAgentLifecycleTool';
import { createLogger } from '../logger';

const log = createLogger('ChatHandler');

// ============================================
// Types
// ============================================
export interface ChatResult {
  status: 'complete' | 'escalated';
  decision: RouterDecision;
}

// ChatMessage type - compatible with routerLlm and generatorLlm
interface ChatMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
  filePointer?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ============================================
// Main Chat Handler
// ============================================
export async function handleChatMessage(config: {
  agentId: string;
  userId: string;
  model: string;
}): Promise<ChatResult> {
  log.info('[ChatHandler] Processing message', {
    agentId: config.agentId,
    model: config.model,
  });

  let computeAuth = await fetchChatComputeAuth(config.userId);

  // Fetch messages from DB
  const dbMessages = await prisma.message.findMany({
    where: { agentId: config.agentId },
    orderBy: { timestamp: 'asc' },
  });

  const messages: ChatMessage[] = dbMessages.map((m) => ({
    role: m.role as 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM',
    text: m.text,
    filePointer: m.filePointer as Record<string, unknown> | undefined,
    metadata: m.metadata as Record<string, unknown> | undefined,
  }));

  // ============================================
  // LLM CALL 1: Router - Decide action
  // Streams reasoning as thinking, detects web_search early
  // ============================================
  const routerAttempt = await callWithChatComputeRotation({
    userId: config.userId,
    agentId: config.agentId,
    phase: 'router',
    initialAuth: computeAuth,
    invoke: (auth, options) =>
      callRouterLlm({
        agentId: config.agentId,
        messages,
        model: config.model,
        claudeToken: auth.claudeToken,
        gptToken: auth.gptToken,
        gptAccountId: auth.gptAccountId,
        disableWaterfall: options.disableWaterfall,
      }),
  });
  computeAuth = routerAttempt.auth;
  const routerResponse = routerAttempt.result;

  const { decision, webSearchToolCallId } = routerResponse;

  recordChatUsage(config.agentId, config.userId, 'chat_router', routerResponse.usage);

  log.info('[ChatHandler] Router decision', {
    agentId: config.agentId,
    action: decision.action,
    reasoning: decision.reasoning.substring(0, 100),
    webSearchDetectedEarly: !!webSearchToolCallId,
  });

  // ============================================
  // BRANCH: start_superintelligence → Escalate to autonomous agent
  // ============================================
  if (decision.action === 'start_superintelligence') {
    log.info('[ChatHandler] Escalating to superintelligence', {
      agentId: config.agentId,
      goal: decision.goal,
      mode: decision.mode,
    });

    // Insert ASSISTANT message with router's reasoning before escalation
    // This clears the thinking bubble and persists the thought
    await createMessage({
      agentId: config.agentId,
      role: 'ASSISTANT',
      text: decision.reasoning,
    });

    const cloudAgentToolCallId = uuidv4();
    await createMessage({
      agentId: config.agentId,
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: cloudAgentToolCallId,
        toolName: CLOUD_AGENT_TOOL_NAME,
        toolStatus: 'IN_PROGRESS',
        title: CREATING_CLOUD_AGENT_TITLE,
      },
    });

    // Start Temporal workflow immediately - NO more LLM calls
    // Pass mode to determine whether to skip PLAN phase
    await startTemporalWorkflowForChat(
      config.agentId,
      config.userId,
      decision.goal,
      decision.mode // 'plan' or 'execute'
    );

    return { status: 'escalated', decision };
  }

  // ============================================
  // BRANCH: web_search → Execute search, then synthesize
  // ============================================
  if (decision.action === 'web_search') {
    // Use tool call ID from early detection, or generate new one
    const streamId = generateStreamId();
    const toolCallId = webSearchToolCallId || uuidv4();

    log.info('[ChatHandler] Executing web search', {
      agentId: config.agentId,
      query: decision.query,
      toolCallId,
      wasDetectedEarly: !!webSearchToolCallId,
    });
    const displayQuery =
      decision.query.length > 80 ? `${decision.query.slice(0, 77)}...` : decision.query;
    const searchTitle = `🔍 Searching the web for ${displayQuery}`;

    // Insert ASSISTANT message with router's reasoning BEFORE tool execution
    // This matches worker behavior where ASSISTANT message comes before tools
    await createMessage({
      agentId: config.agentId,
      role: 'ASSISTANT',
      text: decision.reasoning,
    });

    // If web_search wasn't detected early by router, broadcast IN_PROGRESS now
    if (!webSearchToolCallId) {
      await broadcastToolEvent(
        config.agentId,
        streamId,
        toolCallId,
        'web_search',
        'IN_PROGRESS',
        searchTitle
      );
    }

    // Create IN_PROGRESS message in DB (matches worker behavior)
    // createMessage() auto-broadcasts INSERT event to frontend
    await createMessage({
      agentId: config.agentId,
      role: 'TOOL',
      text: '',
      metadata: {
        title: searchTitle,
        toolName: 'web_search',
        toolCallId,
        toolStatus: 'IN_PROGRESS',
      },
    });

    // Execute search. Backend chat mode does not go through the Python
    // web_search_activity, so it has to pass Fast Mode context explicitly.
    const fastMode = await agentFastMode(config.agentId);
    const searchResult = await executeWebSearch(
      decision.query,
      fastMode.goal,
      fastMode.enabled,
      fastMode.writeEnabled
    );

    // Save tool result as TOOL message using shared helper
    // createMessage() auto-broadcasts INSERT event to frontend
    await createMessage({
      agentId: config.agentId,
      role: 'TOOL',
      text: `Web search: "${decision.query}"\n\n${searchResult.answer}\n\nSources: ${searchResult.sources.join(', ')}`,
      metadata: {
        title: `Web search completed for ${displayQuery}`,
        toolName: 'web_search',
        toolCallId,
        toolStatus: 'FINISHED',
        query: decision.query,
        sources: searchResult.sources,
      },
    });
  }

  // ============================================
  // LLM CALL 2: Generator - Create response
  // Streams reasoning as thinking, returns response for true message
  // (Called for both direct_answer and web_search)
  // ============================================
  log.info('[ChatHandler] Generating response', { agentId: config.agentId });

  // Re-fetch messages to include any new TOOL message
  const updatedDbMessages = await prisma.message.findMany({
    where: { agentId: config.agentId },
    orderBy: { timestamp: 'asc' },
  });

  const updatedMessages: ChatMessage[] = updatedDbMessages.map((m) => ({
    role: m.role as 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM',
    text: m.text,
    filePointer: m.filePointer as Record<string, unknown> | undefined,
  }));

  const generatorAttempt = await callWithChatComputeRotation({
    userId: config.userId,
    agentId: config.agentId,
    phase: 'generator',
    initialAuth: computeAuth,
    invoke: (auth, options) =>
      callGeneratorLlm({
        agentId: config.agentId,
        messages: updatedMessages,
        model: config.model,
        claudeToken: auth.claudeToken,
        gptToken: auth.gptToken,
        gptAccountId: auth.gptAccountId,
        disableWaterfall: options.disableWaterfall,
      }),
  });
  const generatorResponse = generatorAttempt.result;

  recordChatUsage(config.agentId, config.userId, 'chat_generator', generatorResponse.usage);

  // 1. Save reasoning as ASSISTANT message (no metadata) - matches worker behavior
  await createMessage({
    agentId: config.agentId,
    role: 'ASSISTANT',
    text: generatorResponse.reasoning,
  });

  // 2. Save response as TOOL message with send_message_to_user metadata - matches worker behavior
  // createMessage() auto-broadcasts INSERT event to frontend
  const toolCallId = uuidv4();
  await createMessage({
    agentId: config.agentId,
    role: 'TOOL',
    text: generatorResponse.response,
    metadata: {
      toolCallId,
      toolName: 'send_message_to_user',
      toolStatus: 'FINISHED',
      title: 'FYI for User',
      isUserAttentionMessage: true,
      attentionMessage: generatorResponse.response,
      sendMessageToUser: {
        isQuestion: false,
        attentionKind: 'info',
        isWaitingForUser: false,
      },
    },
  });

  // Update agent message count
  const messageCount = updatedDbMessages.length + 1;
  await prisma.agent.update({
    where: { id: config.agentId },
    data: { messageCount },
  });

  log.info('[ChatHandler] Response complete', {
    agentId: config.agentId,
    reasoningLength: generatorResponse.reasoning.length,
    responseLength: generatorResponse.response.length,
    messageCount,
  });

  return { status: 'complete', decision };
}

// ============================================
// Helper: Start Temporal Workflow on Escalation
// ============================================
async function startTemporalWorkflowForChat(
  agentId: string,
  userId: string,
  goal: string,
  startPhase: 'plan' | 'execute' = 'plan'
): Promise<void> {
  // Fetch agent to get model and verifier
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { verifier: true },
  });

  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  if (!agent.verifier) {
    throw new Error(`Agent ${agentId} has no verifier`);
  }

  // Start Temporal workflow (existing function)
  const workflowId = await startAgentWorkflow({
    agentId,
    userId,
    goal: goal || agent.goal, // Use refined goal if provided
    model: agent.model,
    reasoningMaxTokens: agent.reasoningMaxTokens,
    verifier: {
      type: agent.verifier.type,
    },
    startPhase, // 'plan' or 'execute' - determines whether to skip PLAN phase
    priceLimitCents: agent.priceLimitCents,
    fastModeCacheEnabled: agent.fastModeCacheEnabled,
  });

  // Update agent with workflow ID
  await prisma.agent.update({
    where: { id: agentId },
    data: { temporalWorkflowId: workflowId },
  });

  // Broadcast that agent mode started (FE can show different UI)
  await broadcastAgentModeStarted(agentId);

  log.info('[ChatHandler] Escalated to agent mode', {
    agentId,
    workflowId,
    goal: goal.substring(0, 100),
  });
}

function recordChatUsage(
  agentId: string,
  userId: string,
  toolName: string,
  usage: ChatLlmUsage
): void {
  log.info('[ChatHandler] Recording chat usage', {
    agentId,
    toolName,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
  });
  prisma.toolUsage
    .create({
      data: {
        userId,
        agentId,
        toolName,
        totalCostCents: 0,
        usageItems: [
          {
            type: 'llm',
            call_site: 'chat',
            number_of_tokens: usage.total_tokens,
            tokens_in: usage.prompt_tokens,
            tokens_out: usage.completion_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
          },
        ],
      },
    })
    .then(() => {
      log.info('[ChatHandler] Chat usage recorded successfully', { agentId, toolName });
    })
    .catch((err) => {
      log.warn('[ChatHandler] Failed to record chat usage', {
        agentId,
        toolName,
        error: String(err),
      });
    });
}
