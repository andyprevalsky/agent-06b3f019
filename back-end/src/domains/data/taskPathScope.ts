/**
 * grep `trace_path` as an agent task path (`/root/outreach`, as list_agents
 * prints it), resolved inside the caller's own tree:
 *
 *   /root            → the whole tree (agent_network unchanged; trajectories of this tree)
 *   /root/a          → agent /root/a and every agent below it
 *   /root/a/explore  → an in-activity background task → its owner (/root/a)
 *
 * agent_trajectories normally excludes the caller's tree and live (non-terminal)
 * trees; an explicit task path addresses the caller's own tree, so both are
 * lifted for that query.
 *
 * 10k agents: one caller read, the ancestor walk to the root (primary-key
 * reads), and one (busId, taskPath) prefix read for the subtree.
 */

import { AgentNotFoundError, AgentPathNotFoundError, MissingAgentIdError } from './errors';
import { ROOT_AGENT_TASK_PATH } from './path';
import * as repo from './repo';
import type { ValidatedGrepInput } from './types';

function taskPathOf(input: ValidatedGrepInput): string | undefined {
  return input.filters.agentNetwork?.taskPath ?? input.filters.agentTrajectories?.taskPath;
}

function ownsTaskAt(backgroundTasks: unknown, path: string): boolean {
  return (
    Array.isArray(backgroundTasks) &&
    backgroundTasks.some(
      (task) =>
        typeof task === 'object' && task !== null && (task as { path?: unknown }).path === path
    )
  );
}

async function subtreeAgentIds(
  rootId: string,
  userId: string,
  path: string
): Promise<string[] | undefined> {
  if (path === ROOT_AGENT_TASK_PATH) return undefined;
  const rows = await repo.findTreeAgentsAtOrBelowPath(rootId, userId, path);
  if (rows.length > 0) return rows.map((row) => row.id);
  const ownerPath = path.slice(0, path.lastIndexOf('/'));
  const owner = await repo.findTreeAgentAtPath(rootId, userId, ownerPath);
  if (owner !== null && ownsTaskAt(owner.backgroundTasks, path)) return [owner.id];
  throw new AgentPathNotFoundError(path);
}

/** Resolve a task-path `trace_path` into agent-id scopes on the validated input. */
export async function resolveTaskPathScope(
  userId: string,
  input: ValidatedGrepInput,
  agentId: string | undefined
): Promise<ValidatedGrepInput> {
  const path = taskPathOf(input);
  if (path === undefined) return input;
  if (agentId === undefined || agentId === '') throw new MissingAgentIdError();
  if ((await repo.findAgentByIdAndUser(agentId, userId)) === null) {
    throw new AgentNotFoundError(agentId);
  }
  const rootId = await repo.findRootAgentId(agentId, userId);
  const pathAgentIds = await subtreeAgentIds(rootId, userId, path);
  const { agentNetwork, agentTrajectories } = input.filters;
  return {
    ...input,
    filters: {
      ...input.filters,
      agentNetwork: agentNetwork && { ...agentNetwork, pathAgentIds },
      agentTrajectories: agentTrajectories && {
        ...agentTrajectories,
        taskPath: path,
        pathRootAgentId: rootId,
        pathAgentIds,
      },
    },
  };
}
