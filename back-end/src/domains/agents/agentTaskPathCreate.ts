/**
 * Task path for a new agent row: `/root` for a root, `<parent path>/<task_name>`
 * for a sub-agent spawned with a task_name, null otherwise (legacy callers and
 * children of path-less parents stay addressable by id). Sibling uniqueness is
 * enforced inside the create transaction (repoTaskPath.assertTaskPathsFree).
 */

import { ROOT_TASK_PATH, agentTaskPath } from './agentTaskPath';
import { findPathParent } from './repoTaskPath';

interface PathRequest {
  parent_agent_id?: string;
  task_name?: string;
}

export async function resolveCreateTaskPaths(bodies: PathRequest[]): Promise<Array<string | null>> {
  const parentPaths = new Map<string, string | null>();
  const paths: Array<string | null> = [];
  for (const body of bodies) {
    if (body.parent_agent_id === undefined) {
      paths.push(ROOT_TASK_PATH);
      continue;
    }
    if (body.task_name === undefined) {
      paths.push(null);
      continue;
    }
    if (!parentPaths.has(body.parent_agent_id)) {
      const parent = await findPathParent(body.parent_agent_id);
      parentPaths.set(body.parent_agent_id, parent !== null ? agentTaskPath(parent) : null);
    }
    const parentPath = parentPaths.get(body.parent_agent_id) ?? null;
    paths.push(parentPath !== null ? `${parentPath}/${body.task_name}` : null);
  }
  return paths;
}
