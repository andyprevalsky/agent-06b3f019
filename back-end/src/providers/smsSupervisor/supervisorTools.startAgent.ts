/**
 * SMS supervisor start_new_agent commit + web_search execution.
 * Split from supervisorTools.ts to stay under max-lines.
 */

import { prisma } from '../database';
import { startAgentWorkflow } from '../temporal';
import { executeWebSearch } from '../chat/chatTools';
import { getAgentUrl } from '../smsTemplates';
import { createLogger } from '../logger';

const log = createLogger('SmsSupervisorTools');

interface ToolResult {
  tool: string;
  success: boolean;
  result: string;
  error?: string;
}

export interface StartNewAgentArgs {
  goal: string;
  budget_dollars?: number;
}

export interface WebSearchArgs {
  query: string;
}

export async function commitStartNewAgent(
  op: { kind: 'start_new_agent'; args: StartNewAgentArgs; provisionalId: string },
  userId: string
): Promise<ToolResult> {
  const { args, provisionalId } = op;
  const { goal, budget_dollars } = args;
  const priceLimitCents = budget_dollars ? Math.round(budget_dollars * 100) : 100;

  log.info('Starting new agent', {
    phase: 'start',
    userId,
    provisionalId,
    goal: goal.substring(0, 100),
    priceLimitCents,
  });

  let agent;
  try {
    agent = await prisma.$transaction(async (tx) => {
      const newAgent = await tx.agent.create({
        data: {
          // Client-supplied UUID makes commit idempotent: a retried commit
          // would collide on the PK and we catch P2002 below as already-done.
          id: provisionalId,
          userId,
          goal,
          source: 'SMS',
          model: 'rose-labs/rose-1-lite',
          reasoningMaxTokens: 2048,
          status: 'STARTING_UP',
          priceLimitCents,
        },
      });

      await tx.verifier.create({
        data: {
          agentId: newAgent.id,
          type: 'FLOAT_LLM_JUDGE',
        },
      });

      await tx.message.create({
        data: {
          agentId: newAgent.id,
          text: goal,
          role: 'USER',
          timestamp: new Date(),
        },
      });

      return newAgent;
    });
  } catch (error) {
    // P2002 = unique constraint violation. Means this provisional ID was
    // already created — a previous commit fired (the seq gate normally
    // prevents this, but a backend restart mid-flush could rerun us). Treat
    // as already-committed and report the existing agent.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: string }).code === 'P2002'
    ) {
      log.info('start_new_agent commit already done (PK collision)', { provisionalId });
      return {
        tool: 'start_new_agent',
        success: true,
        result: `Agent [${provisionalId.substring(0, 6)}] already started: "${goal.substring(0, 60)}"\nTrack: ${getAgentUrl(provisionalId)}`,
      };
    }
    throw error;
  }

  // Start Temporal workflow
  try {
    const workflowId = await startAgentWorkflow({
      agentId: agent.id,
      userId,
      goal,
      model: 'rose-labs/rose-1-lite',
      reasoningMaxTokens: 2048,
      verifier: {
        type: 'FLOAT_LLM_JUDGE',
      },
      priceLimitCents,
    });

    await prisma.agent.update({
      where: { id: agent.id },
      data: { temporalWorkflowId: workflowId },
    });

    log.info('Agent created and workflow started', {
      phase: 'start',
      agentId: agent.id,
      prefix: agent.id.substring(0, 6),
      workflowId,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error('Failed to start workflow', {
      phase: 'start',
      agentId: agent.id,
      error: errorMsg,
    });

    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: 'FAILED', statusMessage: `Failed to start workflow: ${errorMsg}` },
    });

    return {
      tool: 'start_new_agent',
      success: false,
      result: '',
      error: `Failed to start agent workflow: ${errorMsg}`,
    };
  }

  return {
    tool: 'start_new_agent',
    success: true,
    result: `Agent [${agent.id.substring(0, 6)}] started: "${goal.substring(0, 60)}"\nTrack: ${getAgentUrl(agent.id)}`,
  };
}

export async function executeWebSearchTool(args: WebSearchArgs): Promise<ToolResult> {
  const { query } = args;

  log.info('Executing web search', { phase: 'search', query });
  const startTime = Date.now();

  const searchResult = await executeWebSearch(query);

  log.info('Search complete', {
    phase: 'search',
    query,
    answerLength: searchResult.answer.length,
    sourceCount: searchResult.sources.length,
    durationMs: Date.now() - startTime,
  });

  return {
    tool: 'web_search',
    success: true,
    result: searchResult.answer,
  };
}
