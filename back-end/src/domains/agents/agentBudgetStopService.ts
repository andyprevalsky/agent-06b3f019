/** Defer only an already-acknowledged native browser finalizer. */
import { z } from 'zod';
import * as repo from './repo';
import { getTemporalClient, withTemporalControlDeadline } from '../../providers/temporal';

const Request = z.object({ budget: z.number().int().positive().safe() }).strict();

export async function pauseAtBrowserBudgetForUser(agentId: string, userId: string, body: unknown) {
  const parsed = Request.safeParse(body);
  if (!parsed.success) return { accepted: false };
  const before = await repo.findAgent(agentId, userId);
  if (!before || before.status !== 'ACTIVE' || !before.temporalWorkflowId || !before.temporalFirstExecutionRunId) {
    return { accepted: false };
  }
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(before.temporalWorkflowId, undefined, {
      firstExecutionRunId: before.temporalFirstExecutionRunId,
    });
    const result: unknown = await withTemporalControlDeadline(client, () => handle.executeUpdate(
      'stop_at_browser_budget', { args: [{ budget: parsed.data.budget, first_run_id: before.temporalFirstExecutionRunId }] },
    ));
    const after = await repo.findAgent(agentId, userId);
    if (!after || after.temporalWorkflowId !== before.temporalWorkflowId ||
        after.temporalFirstExecutionRunId !== before.temporalFirstExecutionRunId ||
        after.status !== 'ACTIVE') return { accepted: false };
    const receipt = z.object({ accepted: z.literal(true), task_id: z.string().uuid(),
      run_id: z.string().uuid(), first_run_id: z.literal(before.temporalFirstExecutionRunId),
      deadline: z.number().finite().positive() }).strict().safeParse(result);
    return receipt.success ? receipt.data : { accepted: false };
  } catch {
    // Caller retains its ordinary pause path. No status write or retry here.
    return { accepted: false };
  }
}
