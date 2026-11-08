/**
 * Writes from a CodeAgentResumeWorkflow (agents/workflows/code_agent_resume.py):
 * its activities stamp X-Agent-Workflow-Generation with that workflow's id,
 * `code-resume:<agentId>:<turn row id>`, which is never the owner's
 * temporalWorkflowId. Bound to that agent, such a write belongs to the owner's
 * CURRENT generation (the resume runs beside it, or after it finished), so it is
 * neither fenced as an old worker's write nor allowed to address another agent.
 *
 *   header code-resume:<this agent>:*  → owner's live generation (or its id)
 *   header code-resume:<other agent>:* → unchanged (rejected as stale downstream)
 *   any other header                   → unchanged
 */
import { prisma } from './database';

export const CODE_RESUME_GENERATION_PREFIX = 'code-resume:';

export function isCodeResumeGeneration(agentId: string, generation: string | undefined): boolean {
  return generation?.startsWith(`${CODE_RESUME_GENERATION_PREFIX}${agentId}:`) === true;
}

/** The generation a worker write is attributed to (see the module comment). */
export async function workerWriteGeneration(
  agentId: string,
  generation: string | undefined
): Promise<string | undefined> {
  if (!isCodeResumeGeneration(agentId, generation)) return generation;
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { temporalWorkflowId: true },
  });
  return agent?.temporalWorkflowId ?? agentId;
}
