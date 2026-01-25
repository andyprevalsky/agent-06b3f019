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
import { prisma } from '../prisma';
import { startAgentWorkflow } from '../temporal';
import { createMessage } from '../messages';
import { setResponseSchema } from '../setResponseSchema';
import { callRouterLlm, RouterDecision } from './routerLlm';
import { callGeneratorLlm } from './generatorLlm';
import { executeWebSearch } from './chatTools';
import {
  broadcastToolEvent,
  broadcastAgentModeStarted,
  generateStreamId,
} from './supabaseBroadcast';

// ============================================
// Types
// ============================================
export interface ChatResult {
  status: 'complete' | 'escalated';
  decision: RouterDecision;
}

// ChatMessage type - compatible with routerLlm and generatorLlm
// Uses 'any' for filePointer since it comes from DB as JSON
interface ChatMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
  filePointer?: any; // FilePointer for file attachment messages (from DB JSON)
  metadata?: Record<string, any>;
}

// ============================================
// Main Chat Handler
// ============================================
export async function handleChatMessage(config: {
  agentId: string;
  userId: string;
  model: string;
}): Promise<ChatResult> {
  console.log('[ChatHandler] Processing message', {
    agentId: config.agentId,
    model: config.model,
  });

  // Fetch messages from DB
  const dbMessages = await prisma.message.findMany({
    where: { agentId: config.agentId },
    orderBy: { timestamp: 'asc' },
  });

  const messages: ChatMessage[] = dbMessages.map((m) => ({
    role: m.role as 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM',
    text: m.text,
    filePointer: m.filePointer as Record<string, any> | undefined,
    metadata: m.metadata as Record<string, any> | undefined,
  }));

  // ============================================
  // LLM CALL 1: Router - Decide action
  // Streams reasoning as thinking, detects web_search early
  // ============================================
  const routerResponse = await callRouterLlm({
    agentId: config.agentId,
    messages,
    model: config.model,
  });

  const { decision, webSearchToolCallId } = routerResponse;

  console.log('[ChatHandler] Router decision', {
    action: decision.action,
    reasoning: decision.reasoning.substring(0, 100),
    webSearchDetectedEarly: !!webSearchToolCallId,
  });

  // ============================================
  // BRANCH: start_superintelligence → Escalate to autonomous agent
  // ============================================
  if (decision.action === 'start_superintelligence') {
    console.log('[ChatHandler] Escalating to superintelligence', {
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

    // Start Temporal workflow immediately - NO more LLM calls
    // Pass mode to determine whether to skip PLAN phase
    await startTemporalWorkflowForChat(
      config.agentId,
      config.userId,
      decision.goal,
      decision.mode  // 'plan' or 'execute'
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

    console.log('[ChatHandler] Executing web search', {
      query: decision.query,
      toolCallId,
      wasDetectedEarly: !!webSearchToolCallId,
    });

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
        '🔍 Searching the web'
      );
    }

    // Create IN_PROGRESS message in DB (matches worker behavior)
    // Supabase DB trigger will broadcast INSERT event to frontend
    await createMessage({
      agentId: config.agentId,
      role: 'TOOL',
      text: '',
      metadata: {
        title: '🔍 Searching the web',
        toolName: 'web_search',
        toolCallId,
        toolStatus: 'IN_PROGRESS',
      },
    });

    // Execute search
    const searchResult = await executeWebSearch(decision.query);

    // Save tool result as TOOL message using shared helper
    // Supabase DB trigger will broadcast INSERT event to frontend
    await createMessage({
      agentId: config.agentId,
      role: 'TOOL',
      text: `Web search: "${decision.query}"\n\n${searchResult.answer}\n\nSources: ${searchResult.sources.join(', ')}`,
      metadata: {
        title: 'Web search completed',
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
  console.log('[ChatHandler] Generating response');

  // Re-fetch messages to include any new TOOL message
  const updatedDbMessages = await prisma.message.findMany({
    where: { agentId: config.agentId },
    orderBy: { timestamp: 'asc' },
  });

  const updatedMessages: ChatMessage[] = updatedDbMessages.map((m) => ({
    role: m.role as 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM',
    text: m.text,
    filePointer: m.filePointer as Record<string, any> | undefined,
  }));

  const generatorResponse = await callGeneratorLlm({
    agentId: config.agentId,
    messages: updatedMessages,
    model: config.model,
  });

  // 1. Save reasoning as ASSISTANT message (no metadata) - matches worker behavior
  await createMessage({
    agentId: config.agentId,
    role: 'ASSISTANT',
    text: generatorResponse.reasoning,
  });

  // 2. Save response as TOOL message with send_message_to_user metadata - matches worker behavior
  // Supabase DB trigger will broadcast INSERT event to frontend
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

  console.log('[ChatHandler] Response complete', {
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

  // Generate response schema based on start phase:
  // - Execute mode: fire-and-forget here (no set_plan phase to generate it)
  // - Plan mode: schema is generated during set_plan tool execution (in parallel with planner)
  if (startPhase === 'execute') {
    console.log('🎯 Starting async response schema generation for execute mode', { agentId });
    setResponseSchema(agentId).catch((err) => {
      console.error('❌ Failed to set response schema (background)', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Start Temporal workflow (existing function)
  const workflowId = await startAgentWorkflow({
    agentId,
    userId,
    goal: goal || agent.goal,  // Use refined goal if provided
    model: agent.model,
    reasoningMaxTokens: agent.reasoningMaxTokens,
    verifier: {
      type: agent.verifier.type,
      llmJudgePrompt: agent.verifier.llmJudgePrompt,
    },
    startPhase,  // 'plan' or 'execute' - determines whether to skip PLAN phase
    priceLimitCents: agent.priceLimitCents,
  });

  // Update agent with workflow ID
  await prisma.agent.update({
    where: { id: agentId },
    data: { temporalWorkflowId: workflowId },
  });

  // Broadcast that agent mode started (FE can show different UI)
  await broadcastAgentModeStarted(agentId);

  console.log('[ChatHandler] Escalated to agent mode', {
    agentId,
    workflowId,
    goal: goal.substring(0, 100),
  });
}
