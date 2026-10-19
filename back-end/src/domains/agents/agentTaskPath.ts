/**
 * Codex-style task paths: every agent in a tree is addressed by the path of
 * task names from the root, e.g. `/root/outreach/draft_a`.
 *
 *   root agent                     → /root                (stored on create)
 *   child spawned with task_name   → <parent path>/<task_name>
 *   in-activity background task    → <owner path>/<task_name> (Agent.backgroundTasks[].path)
 *
 * A task_name is unique among one spawner's live children, so a path names at
 * most one live agent per tree (busId). Agents created before paths existed
 * keep a null path and stay addressable by id.
 */

export const ROOT_TASK_PATH = '/root';
// for_each children append `_<i>`; paths are bounded by MAX_DEPTH (4) segments.
export const TASK_PATH_MAX_CHARS = 400;
const TASK_PATH_PATTERN = /^\/root(\/[a-z][a-z0-9_]{0,59})*$/;

/** A tree is identified by its root id, which every descendant carries as busId. */
export function rootOf(agent: { id: string; busId: string | null }): string {
  return agent.busId !== null && agent.busId !== '' ? agent.busId : agent.id;
}

export class TaskPathConflictError extends Error {
  constructor(readonly taskPath: string) {
    super(
      `task_name already used: ${taskPath} is taken by a live sibling. ` +
        'Choose a different task_name for this child.'
    );
    this.name = 'TaskPathConflictError';
  }
}

export function isTaskPath(value: string): boolean {
  return value.length <= TASK_PATH_MAX_CHARS && TASK_PATH_PATTERN.test(value);
}

/** Parent path of a non-root path (`/root/a/b` → `/root/a`); null for `/root`. */
export function parentTaskPath(path: string): string | null {
  if (path === ROOT_TASK_PATH) return null;
  return path.slice(0, path.lastIndexOf('/'));
}

/** An agent's own path: the stored one, `/root` for a (legacy) root, else null. */
export function agentTaskPath(agent: {
  taskPath: string | null;
  parentAgentId: string | null;
}): string | null {
  if (agent.taskPath !== null) return agent.taskPath;
  return agent.parentAgentId === null ? ROOT_TASK_PATH : null;
}
