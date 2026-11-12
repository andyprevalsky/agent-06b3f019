import { isWorkflowStartAdmissionPending } from '../workflowQueueAdmission';
/**
 * Chat Handler - Core orchestrator for chat mode.
 * Implements the fixed LLM call sequence based on Manus architecture:
 *
 * - direct_answer: Router → Generator (2 LLM calls)
 * - web_search / grep: Router → search round → Router → … → Generator or escalation
 *   (up to MAX_CHAT_SEARCH_ROUNDS search rounds shared by both kinds; the
 *   Generator overlaps each after-search Router and is committed only when
 *   that Router answers). A grep round runs the shared grep tool definition
 *   on the user's own data (chatGrepRound.ts).
 * - agent_start_task: Router only → start Temporal (1 LLM call, exit)
 *
 * Both Router and Generator stream their reasoning as ASSISTANT_STREAM (thinking).
 * Only the Generator's response field is saved as the true ASSISTANT message (INSERT).
 *
 * System context / state flow:
 *
 *   startInitialChatContext ──┬─ messages ──> Router (GLM) ──> Cerebras
 *   loadRouterProjectContext ─┤  (one read per turn: project section after the Router's and
 *                             │   the Generator's cached prompts)
 *                             │                 │                 (fail closed)
 *                             │                 ├─ escalation ──> Temporal (router only)
 *                             │                 v
 *                             │             Generator (Lite)
 *                             │                 └─ Cerebras Gemma-4-31B
 *                             ├─ direct_answer ──> reuse initial message snapshot
 *                             │    └─ Router-start Generator ──> buffered until commit
 *                             ├─ web_search ──> round: 1+ queries in parallel ──> reload
 *                             ├─ grep ───────> round: one grep tool call ───────> reload
 *                             │    └─ closed action ──> abort/discard speculation
 *                             └─ round results ──> Router (after_search; the last
 *                                  │                round's route cannot search)
 *                                  ├─ web_search | grep ──> next round
 *                                  ├─ direct_answer ──> commit overlapped Generator
 *                                  └─ escalation ──> discard Generator, Temporal
 *
 * Synchronous chat uses explicit phase routes and performs no OAuth credential
 * lookup or rotation. A later Temporal workflow retains its requested-model auth path.
 */

import type { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../database';
import { loadChatUserProfileContext } from './chatUserContext';
import { startAgentWorkflowExecution, type TemporalWorkflowExecutionRef } from '../temporal';
import { normalizeWorldModelMode } from '../worldModelMode';
import { createMessage } from '../messages';
import { acceptChatWorkflowExecution } from '../workflowGeneration';
import { terminateStaleTemporalWorkflow } from '../workflowReplacement';
import { callRouterLlm, RouterDecision, type ChatLlmUsage } from './routerLlm';
import { MAX_CHAT_SEARCH_ROUNDS, type RouterStage } from './routerDecision';
import { runChatWebSearchRound, type WebSearchDecision } from './chatWebSearchRound';
import { runChatGrepRound, type GrepDecision } from './chatGrepRound';
import { callGeneratorLlm, type GeneratorResponse } from './generatorLlm';
import { selectChatPhaseModels, type ChatPhaseModels } from './phaseModels';
import { startInitialChatContext, loadChatModelMessages, type ChatMessage } from './initialContext';
import { broadcastAgentModeStarted } from './supabaseBroadcast';
import { CLOUD_AGENT_TOOL_NAME, CREATING_CLOUD_AGENT_TITLE } from './cloudAgentLifecycleTool';
import { withChatEscalationDeadline } from './chatEscalationDeadline';
import { createLogger } from '../logger';
import { loadRouterProjectContext } from './projectContext';
import { followUpRunStateUpdate, shouldSnapshotPreviousGoal } from '../derivedRunState';
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
/** Run routing, tools and answer generation for a chat turn with one evidence root. */
export async function handleChatMessage(config: {
  agentId: string;
  rootAgentId?: string;
  userId: string;
  model: string;
}): Promise<ChatResult> {
  log.info('[ChatHandler] Processing message', {
    agentId: config.agentId,
    model: config.model,
  });

  const phaseModels = selectChatPhaseModels(config.model);

  const initialContext = startInitialChatContext({
    agentId: config.agentId,
    rootAgentId: config.rootAgentId,
    requestedModel: config.model,
  });
  const [messages, projectContext, userProfileContext] = await Promise.all([
    initialContext.messages,
    loadRouterProjectContext(config.agentId),
    loadChatUserProfileContext(config.agentId, config.userId),
  ]);
  const chatContextConfig = {
    agentId: config.agentId,
    rootAgentId: config.rootAgentId,
    requestedModel: config.model,
  };

  const runGenerator = async (
    generatorMessages: typeof messages,
    speculative?: { abortSignal: AbortSignal; streamGate: TransactionalStreamGate }
  ) => {
    return callGeneratorLlm({
      agentId: config.agentId,
      rootAgentId: config.rootAgentId,
      messages: generatorMessages,
      model: phaseModels.generator,
      providerRoute: phaseModels.generatorProviderRoute,
      abortSignal: speculative?.abortSignal,
      streamGate: speculative?.streamGate,
      projectContext,
      userProfileContext,
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
      rootAgentId: config.rootAgentId,
      messages,
      model: phaseModels.router,
      providerRoute: phaseModels.routerProviderRoute,
      projectContext,
      userProfileContext,
      onRouterStarted: shouldSpeculateDirectAnswer ? speculativeGenerator.start : undefined,
      onActionDetected: (action) => {
        if (action !== 'direct_answer') void speculativeGenerator.discard();
      },
    });
  } catch (error) {
    await speculativeGenerator.discard();
    throw error;
  }

  const { decision, webSearchToolCallId, streamId: routerStreamId } = routerResponse;

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
  // (from the initial route, or from the route after the web search)
  // ============================================
  const escalate = async (
    decision: Extract<RouterDecision, { action: 'start_superintelligence' }>,
    producerStreamId: string
  ): Promise<ChatResult> => {
    log.info('[ChatHandler] Escalating to superintelligence', {
      agentId: config.agentId,
      goal: decision.goal,
      mode: decision.mode,
    });

    // Persist ASSISTANT + Cloud Agent chip before Temporal start.
    // Prefetch the agent row only on this branch so it overlaps those writes.
    const cloudAgentToolCallId = uuidv4();
    const escalationAgentPromise = prisma.agent.findUnique({
      where: { id: config.agentId },
      include: { verifier: true },
    });
    const prefetchedAgent = await withChatEscalationDeadline(async () => {
      const agentRow = await escalationAgentPromise;
      await createMessage({
        agentId: config.agentId,
        role: 'ASSISTANT',
        text: decision.reasoning,
        metadata: { streamId: producerStreamId },
      });
      // Post-completion cutover: keep the prior Agent.goal on this chip so
      // replacing the live pointer does not drop the finished task's goal.
      // First-run escalate leaves Agent.goal (and this snapshot) alone.
      const snapshotPreviousGoal =
        agentRow !== null &&
        (agentRow.structuredResponse !== null || agentRow.progress > 0) &&
        shouldSnapshotPreviousGoal(decision.goal, agentRow.goal);
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
          ...(snapshotPreviousGoal ? { previousGoal: agentRow.goal } : {}),
        },
      });
      return agentRow;
    });

    let started: boolean;
    try {
      started = await startTemporalWorkflowForChat(
        config.agentId,
        config.userId,
        decision.goal,
        decision.mode,
        prefetchedAgent
      );
    } catch (error) {
      if (isWorkflowStartAdmissionPending(error)) throw error;
      // Pre-acceptance failures only: startTemporalWorkflowForChat swallows
      // post-acceptance broadcast errors and returns true after acceptance.
      // Always rethrow after terminalizing so we never claim `complete` while an
      // unaccepted Temporal execution may still be running (cleanup failure).
      log.error('[ChatHandler] Cloud Agent escalation failed after tool start', {
        agentId: config.agentId,
        error,
      });
      try {
        await finishRejectedCloudAgentTool({
          agentId: config.agentId,
          toolCallId: cloudAgentToolCallId,
          startPhase: decision.mode,
          text: 'Could not start Cloud Agent — workflow acceptance failed',
        });
      } catch (terminalError) {
        log.error('[ChatHandler] Failed to terminalize Cloud Agent tool after start failure', {
          agentId: config.agentId,
          error,
          terminalError,
        });
      }
      throw error;
    }
    if (!started) {
      // Agent became ineligible between router decision and start (already has a
      // workflow, or left ACTIVE). Do not report escalation that did not occur.
      try {
        await finishRejectedCloudAgentTool({
          agentId: config.agentId,
          toolCallId: cloudAgentToolCallId,
          startPhase: decision.mode,
          text: 'Could not start Cloud Agent — agent is no longer eligible to escalate',
        });
      } catch (terminalError) {
        log.error('[ChatHandler] Failed to terminalize Cloud Agent tool after rejected start', {
          agentId: config.agentId,
          terminalError,
        });
        throw terminalError;
      }
      return { status: 'complete', decision };
    }

    return { status: 'escalated', decision };
  };

  if (decision.action === 'start_superintelligence') {
    return escalate(decision, routerStreamId);
  }

  // ============================================
  // BRANCH: web_search or grep → search, then route again with the results.
  // The Router owns escalation; the Generator can only reply. After each
  // round the Router answers, searches again (either kind), or escalates;
  // once the turn's rounds are spent it can only answer or escalate.
  // ============================================
  let generatorMessages = messages;
  let earlyGeneratorResponse: GeneratorResponse | null;
  if (decision.action === 'web_search' || decision.action === 'grep') {
    let search: WebSearchDecision | GrepDecision = decision;
    let earlyToolCallId = webSearchToolCallId;
    let searchRouterStreamId = routerStreamId;
    for (let round = 1; ; round += 1) {
      if (search.action === 'web_search') {
        await runChatWebSearchRound({
          agentId: config.agentId,
          decision: search,
          earlyToolCallId,
          routerStreamId: searchRouterStreamId,
        });
      } else {
        await runChatGrepRound({
          agentId: config.agentId,
          userId: config.userId,
          decision: search,
          routerStreamId: searchRouterStreamId,
        });
      }
      generatorMessages = await loadChatModelMessages(chatContextConfig);
      const next = await routeAfterSearch({
        agentId: config.agentId,
        rootAgentId: config.rootAgentId,
        userId: config.userId,
        messages: generatorMessages,
        phaseModels,
        projectContext,
        userProfileContext,
        runGenerator,
        stage: round < MAX_CHAT_SEARCH_ROUNDS ? 'after_search' : 'search_budget_spent',
      });
      if (next.decision.action === 'start_superintelligence') {
        return escalate(next.decision, next.routerStreamId);
      }
      if (next.decision.action === 'direct_answer') {
        earlyGeneratorResponse = next.generatorResponse;
        break;
      }
      search = next.decision;
      earlyToolCallId = next.webSearchToolCallId;
      searchRouterStreamId = next.routerStreamId;
    }
  } else {
    earlyGeneratorResponse = await speculativeGenerator.commitDirectAnswer();
  }

  // ============================================
  // Generator - Create response
  // Streams reasoning as thinking, returns response for true message
  // (Called for direct_answer, and for a search the Router answered)
  // ============================================
  log.info('[ChatHandler] Generating response', { agentId: config.agentId });

  const generatorResponse = earlyGeneratorResponse ?? (await runGenerator(generatorMessages));

  recordChatUsage(config.agentId, config.userId, 'chat_generator', generatorResponse.usage);

  // Persist the identity of the reasoning stream this canonical row closes.
  await createMessage({
    agentId: config.agentId,
    role: 'ASSISTANT',
    text: generatorResponse.reasoning,
    metadata: { streamId: generatorResponse.streamId },
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
// Helper: Route again after a search round (web searches or grep)
// ============================================
/**
 * Most searches answer the question, so the Generator overlaps this route
 * under the same commit/discard gate the initial direct_answer speculation uses.
 */
async function routeAfterSearch(params: {
  agentId: string;
  rootAgentId?: string;
  userId: string;
  messages: ChatMessage[];
  phaseModels: ChatPhaseModels;
  projectContext: string;
  userProfileContext: string;
  stage: Exclude<RouterStage, 'initial'>;
  runGenerator: (
    messages: ChatMessage[],
    speculative: { abortSignal: AbortSignal; streamGate: TransactionalStreamGate }
  ) => Promise<GeneratorResponse>;
}): Promise<{
  decision: RouterDecision;
  generatorResponse: GeneratorResponse | null;
  webSearchToolCallId?: string;
  routerStreamId: string;
}> {
  const speculativeGenerator = createEarlyDirectGeneratorCoordinator({
    start: (speculative) => params.runGenerator(params.messages, speculative),
  });
  let routerResponse;
  try {
    routerResponse = await callRouterLlm({
      agentId: params.agentId,
      rootAgentId: params.rootAgentId,
      messages: params.messages,
      model: params.phaseModels.router,
      providerRoute: params.phaseModels.routerProviderRoute,
      projectContext: params.projectContext,
      userProfileContext: params.userProfileContext,
      stage: params.stage,
      onRouterStarted: speculativeGenerator.start,
      onActionDetected: (action) => {
        if (action !== 'direct_answer') void speculativeGenerator.discard();
      },
    });
  } catch (error) {
    await speculativeGenerator.discard();
    throw error;
  }

  recordChatUsage(params.agentId, params.userId, 'chat_router', routerResponse.usage);
  const { decision } = routerResponse;
  log.info('[ChatHandler] Router decision after search', {
    agentId: params.agentId,
    stage: params.stage,
    action: decision.action,
    reasoning: decision.reasoning.substring(0, 100),
  });

  if (decision.action !== 'direct_answer') {
    await speculativeGenerator.discard();
    return {
      decision,
      generatorResponse: null,
      webSearchToolCallId: routerResponse.webSearchToolCallId,
      routerStreamId: routerResponse.streamId,
    };
  }
  return {
    decision,
    generatorResponse: await speculativeGenerator.commitDirectAnswer(),
    routerStreamId: routerResponse.streamId,
  };
}

// ============================================
// Helper: Terminalize a rejected Cloud Agent tool
// ============================================
async function finishRejectedCloudAgentTool(params: {
  agentId: string;
  toolCallId: string;
  startPhase: 'plan' | 'execute';
  text: string;
}): Promise<void> {
  await createMessage({
    agentId: params.agentId,
    role: 'TOOL',
    text: params.text,
    skipDuplicateToolCheck: true,
    metadata: {
      toolCallId: params.toolCallId,
      toolName: CLOUD_AGENT_TOOL_NAME,
      toolStatus: 'FINISHED',
      title: CREATING_CLOUD_AGENT_TITLE,
      startPhase: params.startPhase,
      error: true,
    },
  });
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
  startPhase: 'plan' | 'execute' = 'plan',
  prefetchedAgent?: Prisma.AgentGetPayload<{ include: { verifier: true } }> | null
): Promise<boolean> {
  const loadedAgent =
    prefetchedAgent ??
    (await prisma.agent.findUnique({
      where: { id: agentId },
      include: { verifier: true },
    }));

  if (loadedAgent === null) {
    throw new Error(`Agent ${agentId} not found`);
  }

  if (loadedAgent.verifier === null) {
    throw new Error(`Agent ${agentId} has no verifier`);
  }
  const verifier = loadedAgent.verifier;
  if (loadedAgent.temporalWorkflowId !== null || loadedAgent.status !== 'ACTIVE') return false;

  // A follow-up after a finished run must not inherit that run's derived
  // artifacts, and Agent.goal must become the chat-router task so schema /
  // demo-cache / UI base off the new instruction. First-run escalation has
  // progress 0 and no structuredResponse, so it keeps create-time goal+schema
  // (2026-07-03: do not persist an LLM paraphrase over the original row).
  //
  //   first-run escalate: Agent.goal unchanged, schema kept
  //   post-completion:    Agent.goal = router goal, previousGoal snapshotted
  //                       on the Cloud Agent chip, derived state nulled
  const agent = loadedAgent;
  let persistedGoal = agent.goal;
  if (agent.structuredResponse !== null || agent.progress > 0) {
    const update = followUpRunStateUpdate(goal, agent.goal);
    await prisma.agent.update({
      where: { id: agentId },
      data: update,
    });
    if (typeof update.goal === 'string') {
      persistedGoal = update.goal;
    }
  }

  // Start Temporal workflow (existing function)
  const execution = await startAgentWorkflowExecution(
    buildChatTemporalStartParams({
      agentId,
      userId,
      goal,
      startPhase,
      agent: {
        goal: persistedGoal,
        model: agent.model,
        reasoningMaxTokens: agent.reasoningMaxTokens,
        verifier: { type: verifier.type },
        priceLimitCents: agent.priceLimitCents,
        fastModeCacheEnabled: agent.fastModeCacheEnabled,
        worldModelMode: agent.worldModelMode,
      },
    })
  );
  let accepted: boolean;
  try {
    accepted = await acceptChatWorkflowExecution(agentId, execution);
  } catch (error) {
    await terminateUnacceptedChatWorkflow(execution, agentId).catch((cleanupError: unknown) =>
      log.error('[ChatHandler] Failed to terminate unaccepted workflow after accept throw', {
        agentId,
        cleanupError,
      })
    );
    throw error;
  }
  if (!accepted) {
    // Cleanup must succeed before callers report a clean rejected start; otherwise
    // Temporal may still be running while chat claims the escalation finished.
    await terminateUnacceptedChatWorkflow(execution, agentId);
    return false;
  }

  // Broadcast is best-effort after acceptance is persisted. A transport failure
  // must not be treated as a rejected start (workflow already owns the agent).
  try {
    await broadcastAgentModeStarted(agentId);
  } catch (error) {
    log.error('[ChatHandler] Failed to broadcast agent mode started after acceptance', {
      agentId,
      workflowId: execution.workflowId,
      error,
    });
  }

  log.info('[ChatHandler] Escalated to agent mode', {
    agentId,
    workflowId: execution.workflowId,
    goal: goal.substring(0, 100),
  });
  return true;
}

const UNACCEPTED_TERMINATE_ATTEMPTS = 3;

async function terminateUnacceptedChatWorkflow(
  execution: TemporalWorkflowExecutionRef,
  agentId: string
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= UNACCEPTED_TERMINATE_ATTEMPTS; attempt += 1) {
    try {
      await terminateStaleTemporalWorkflow(execution, agentId);
      return;
    } catch (error) {
      lastError = error;
      log.error('[ChatHandler] Unaccepted workflow terminate attempt failed', {
        agentId,
        workflowId: execution.workflowId,
        attempt,
        attempts: UNACCEPTED_TERMINATE_ATTEMPTS,
        error,
      });
    }
  }
  log.error('[ChatHandler] Unaccepted workflow cleanup exhausted retries', {
    agentId,
    workflowId: execution.workflowId,
    attempts: UNACCEPTED_TERMINATE_ATTEMPTS,
    error: lastError,
  });
  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to terminate unaccepted chat workflow');
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
