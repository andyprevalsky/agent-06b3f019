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
 *
 * System context / state flow:
 *
 *   startInitialChatContext ──┬─ messages ──> Router (GLM) ──> Cerebras
 *                             │                 │                 (fail closed)
 *                             │                 ├─ escalation ──> Temporal (router only)
 *                             │                 v
 *                             │             Generator (Lite)
 *                             │                 └─ Cerebras Gemma-4-31B
 *                             ├─ direct_answer ──> reuse initial message snapshot
 *                             │    └─ Router-start Generator ──> buffered until commit
 *                             ├─ web_search/future writes ──> refresh messages
 *                             │    └─ closed action ──> abort/discard speculation
 *
 * Synchronous chat uses explicit phase routes and performs no OAuth credential
 * lookup or rotation. A later Temporal workflow retains its requested-model auth path.
 */

import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../database';
import { startAgentWorkflowExecution } from '../temporal';
import { normalizeWorldModelMode } from '../worldModelMode';
import { createMessage } from '../messages';
import { acceptChatWorkflowExecution } from '../workflowGeneration';
import { terminateStaleTemporalWorkflow } from '../workflowReplacement';
import { callRouterLlm, RouterDecision, type ChatLlmUsage } from './routerLlm';
import { callGeneratorLlm } from './generatorLlm';
import { selectChatPhaseModels } from './phaseModels';
import { executeWebSearch } from './chatTools';
import { agentFastMode } from '../fastCacheStore';
import {
  mapChatDatabaseMessages,
  resolveGeneratorMessages,
  startInitialChatContext,
} from './initialContext';
import {
  broadcastToolEvent,
  broadcastAgentModeStarted,
  generateStreamId,
} from './supabaseBroadcast';
import { CLOUD_AGENT_TOOL_NAME, CREATING_CLOUD_AGENT_TITLE } from './cloudAgentLifecycleTool';
import { createLogger } from '../logger';
import {
  createEarlyDirectGeneratorCoordinator,
  shouldStartEarlyDirectGenerator,
  type TransactionalStreamGate,
} from './earlyDirectGenerator';

const log = createLogger('ChatHandler');

// ============================================
// Types
// ============================================
export interface ChatResult {
  status: 'complete' | 'escalated';
  decision: RouterDecision;
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

  const phaseModels = selectChatPhaseModels(config.model);

  const initialContext = startInitialChatContext(config);
  const messages = await initialContext.messages;

  const runGenerator = async (
    generatorMessages: typeof messages,
    speculative?: { abortSignal: AbortSignal; streamGate: TransactionalStreamGate }
  ) => {
    return callGeneratorLlm({
      agentId: config.agentId,
      messages: generatorMessages,
      model: phaseModels.generator,
      providerRoute: phaseModels.generatorProviderRoute,
      abortSignal: speculative?.abortSignal,
      streamGate: speculative?.streamGate,
    });
  };

  const speculativeGenerator = createEarlyDirectGeneratorCoordinator({
    start: ({ abortSignal, streamGate }) => runGenerator(messages, { abortSignal, streamGate }),
  });
  const shouldSpeculateDirectAnswer = shouldStartEarlyDirectGenerator(messages);

  // ============================================
  // LLM CALL 1: Router - Decide action
  // Streams reasoning as thinking, detects web_search early
  // ============================================
  let routerResponse;
  try {
    routerResponse = await callRouterLlm({
      agentId: config.agentId,
      messages,
      model: phaseModels.router,
      providerRoute: phaseModels.routerProviderRoute,
      onRouterStarted: shouldSpeculateDirectAnswer ? speculativeGenerator.start : undefined,
      onActionDetected: (action) => {
        if (action !== 'direct_answer') void speculativeGenerator.discard();
      },
    });
  } catch (error) {
    await speculativeGenerator.discard();
    throw error;
  }

  const { decision, webSearchToolCallId } = routerResponse;

  if (decision.action !== 'direct_answer') {
    await speculativeGenerator.discard();
  }

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
      skipDuplicateToolCheck: true,
      metadata: {
        toolCallId: cloudAgentToolCallId,
        toolName: CLOUD_AGENT_TOOL_NAME,
        toolStatus: 'IN_PROGRESS',
        title: CREATING_CLOUD_AGENT_TITLE,
        startPhase: decision.mode,
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
      skipDuplicateToolCheck: true,
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
      skipDuplicateToolCheck: true,
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

  const generatorMessages = await resolveGeneratorMessages({
    action: decision.action,
    initialMessages: messages,
    refreshMessages: async () => {
      const refreshedDbMessages = await prisma.message.findMany({
        where: { agentId: config.agentId },
        orderBy: { timestamp: 'asc' },
      });
      return mapChatDatabaseMessages(refreshedDbMessages);
    },
  });

  const earlyGeneratorResponse =
    decision.action === 'direct_answer' ? await speculativeGenerator.commitDirectAnswer() : null;
  const generatorResponse = earlyGeneratorResponse ?? (await runGenerator(generatorMessages));

  recordChatUsage(config.agentId, config.userId, 'chat_generator', generatorResponse.usage);

  // 1. Save reasoning as ASSISTANT message (no metadata) - matches worker behavior
  await createMessage({
    agentId: config.agentId,
    role: 'ASSISTANT',
    text: generatorResponse.reasoning,
  });

  // 2. Save response as TOOL message with send_message_to_user metadata - matches worker behavior
  // createMessage() auto-broadcasts INSERT event to frontend
  await createMessage({
    agentId: config.agentId,
    role: 'TOOL',
    text: generatorResponse.response,
    skipDuplicateToolCheck: true,
    metadata: {
      toolCallId: generatorResponse.toolCallId,
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
  const messageCount = generatorMessages.length + 1;
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
interface ChatTemporalAgentConfig {
  goal: string;
  model: string;
  reasoningMaxTokens: number;
  verifier: { type: string };
  priceLimitCents: number;
  fastModeCacheEnabled: boolean;
  worldModelMode: string;
}

export function buildChatTemporalStartParams(params: {
  agentId: string;
  userId: string;
  goal: string;
  startPhase: 'plan' | 'execute';
  agent: ChatTemporalAgentConfig;
}) {
  return {
    agentId: params.agentId,
    userId: params.userId,
    goal: params.goal || params.agent.goal,
    model: params.agent.model,
    reasoningMaxTokens: params.agent.reasoningMaxTokens,
    verifier: { type: params.agent.verifier.type },
    startPhase: params.startPhase,
    priceLimitCents: params.agent.priceLimitCents,
    fastModeCacheEnabled: params.agent.fastModeCacheEnabled,
    worldModelMode: normalizeWorldModelMode(params.agent.worldModelMode),
  };
}

async function startTemporalWorkflowForChat(
  agentId: string,
  userId: string,
  goal: string,
  startPhase: 'plan' | 'execute' = 'plan'
): Promise<boolean> {
  // Fetch agent to get model and verifier
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { verifier: true },
  });

  if (agent === null) {
    throw new Error(`Agent ${agentId} not found`);
  }

  if (agent.verifier === null) {
    throw new Error(`Agent ${agentId} has no verifier`);
  }
  if (agent.temporalWorkflowId !== null || agent.status !== 'ACTIVE') return false;

  // Start Temporal workflow (existing function)
  const execution = await startAgentWorkflowExecution(
    buildChatTemporalStartParams({
      agentId,
      userId,
      goal,
      startPhase,
      agent: {
        goal: agent.goal,
        model: agent.model,
        reasoningMaxTokens: agent.reasoningMaxTokens,
        verifier: { type: agent.verifier.type },
        priceLimitCents: agent.priceLimitCents,
        fastModeCacheEnabled: agent.fastModeCacheEnabled,
        worldModelMode: agent.worldModelMode,
      },
    })
  );
  const accepted = await acceptChatWorkflowExecution(agentId, execution);
  if (!accepted) {
    await terminateStaleTemporalWorkflow(execution, agentId);
    return false;
  }

  // Broadcast that agent mode started (FE can show different UI)
  await broadcastAgentModeStarted(agentId);

  log.info('[ChatHandler] Escalated to agent mode', {
    agentId,
    workflowId: execution.workflowId,
    goal: goal.substring(0, 100),
  });
  return true;
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
            model: usage.model,
            from_fast_cache: usage.from_fast_cache,
            cost_cents: 0,
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
