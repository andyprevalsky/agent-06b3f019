/**
 * Agent-to-agent control writes (agentWakeService.ts).
 *
 * Every query is keyed by Agent.id, so cost scales with the one agent being acted on.
 */

import { Prisma, type Agent } from '@prisma/client';
import { prisma } from '../../providers/database';
import { type DERIVED_RUN_STATE_RESET } from '../../providers/derivedRunState';

/**
 * Every Agent field a wake rewrites before its workflow starts: the terminal
 * CAS (status, workflow identity, derived run state) and the follow-up goal.
 */
type WakeRewrittenField =
  | keyof typeof DERIVED_RUN_STATE_RESET
  | 'status'
  | 'temporalWorkflowId'
  | 'temporalFirstExecutionRunId'
  | 'goal';

/** The finished agent's values for those fields, as observed before the wake. */
export type PreWakeAgentState = Pick<Agent, WakeRewrittenField>;

function jsonColumn(value: Prisma.JsonValue): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/**
 * Undo a wake whose workflow start failed: put back every field the wake
 * rewrote (only while nothing else claimed the row), so the finished agent
 * keeps its goal, result and run identity.
 */
export async function restoreTerminalAgentAfterFailedWake(
  agentId: string,
  before: PreWakeAgentState
) {
  const data = {
    status: before.status,
    temporalWorkflowId: before.temporalWorkflowId,
    temporalFirstExecutionRunId: before.temporalFirstExecutionRunId,
    goal: before.goal,
    responseSchema: jsonColumn(before.responseSchema),
    structuredResponse: jsonColumn(before.structuredResponse),
    progress: before.progress,
    toolsInUse: before.toolsInUse,
    statusMessage: before.statusMessage,
  } satisfies Record<WakeRewrittenField, unknown>;
  return prisma.agent.updateMany({
    where: { id: agentId, status: 'ACTIVE', temporalWorkflowId: null },
    data,
  });
}
