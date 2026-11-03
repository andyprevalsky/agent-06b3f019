/**
 * Task-addressed agent messages to browser/code background tasks.
 *
 *   running ──▶ delivered
 *   completed / failed ──▶ 409, nothing stored
 *   paused ──▶ needs continue_conversation (400 without it), then resumes
 */

// Browser/code tasks keep live state: a finished one cannot be messaged, a paused
// one resumes with an explicit continue_conversation (agents/helpers/background_agents.py).
const RESUMABLE_TASK_TYPES = new Set(['browser', 'code']);
const FINISHED_TASK_STATUSES = new Set(['completed', 'failed']);
const PAUSED_TASK_STATUS = 'paused';

/** Why a task-addressed message is refused (structured type/status only), or null. */
export function taskMessageRefusal(
  task: { type: string; status: string } | undefined,
  address: string,
  continueConversation: boolean | undefined
): { error: string; status: number } | null {
  if (task === undefined || !RESUMABLE_TASK_TYPES.has(task.type)) return null;
  if (FINISHED_TASK_STATUSES.has(task.status)) {
    return {
      error:
        `${address} is a ${task.status} ${task.type} agent; completed browser and code agents ` +
        `cannot be messaged. Spawn a new ${task.type} agent for new work.`,
      status: 409,
    };
  }
  if (task.status === PAUSED_TASK_STATUS && continueConversation === undefined) {
    return {
      error:
        `${address} is a paused ${task.type} agent; set continue_conversation to true to resume ` +
        'its exact prior conversation or false to start a fresh one.',
      status: 400,
    };
  }
  return null;
}
