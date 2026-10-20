/**
 * The one address resolver for agent-to-agent tools (send_message_to_agent today;
 * follow-up / interrupt / wait later). An address is resolved relative to the
 * calling agent and only within the caller's tree and owner:
 *
 *   "parent"                  → caller's parent agent
 *   "/root"                   → tree root
 *   "/root/a/b"               → agent with that task path, else the background
 *                               task (running or finished) with that path on /root/a
 *   "<agent uuid>"            → that agent (fallback for agents without a path)
 *   "<agent uuid>/<task id>"  → background task on a path-less owner
 *
 * Cost: at most one primary-key read plus one (busId, taskPath) read.
 */

import { listedBackgroundTasks } from './agentTreeBackgroundTasks';
import { ROOT_TASK_PATH, agentTaskPath, isTaskPath, parentTaskPath, rootOf } from './agentTaskPath';
import * as treeRepo from './repoAgentTree';
import * as pathRepo from './repoTaskPath';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(`^${UUID}$`, 'i');
// `<owner id>/<task id>`: a background task on an owner created before paths.
const OWNER_TASK_PATTERN = new RegExp(`^(${UUID})/([A-Za-z0-9_:.-]{1,200})$`, 'i');

export interface AddressCaller {
  id: string;
  userId: string;
  busId: string | null;
  parentAgentId: string | null;
}

export interface ResolvedAddress {
  agent_id: string;
  /** Set when the address names an in-activity background task on `agent_id`. */
  recipient_task_id: string | null;
  path: string | null;
  type: string;
}

type ServiceError = { error: string; status: number };

async function resolveAgentId(
  caller: AddressCaller,
  agentId: string,
  address: string
): Promise<ResolvedAddress | ServiceError> {
  const [row] = await treeRepo.findTreeNodesByIds([agentId]);
  if (row === undefined || row.deletedAt !== null || row.userId !== caller.userId) {
    return { error: `No agent at ${address}`, status: 404 };
  }
  if (rootOf(row) !== rootOf(caller)) {
    return { error: `${address} is not in your agent tree`, status: 403 };
  }
  return { agent_id: row.id, recipient_task_id: null, path: agentTaskPath(row), type: 'agent' };
}

async function resolvePath(
  caller: AddressCaller,
  path: string
): Promise<ResolvedAddress | ServiceError> {
  const rootId = rootOf(caller);
  const ownerPath = parentTaskPath(path) ?? ROOT_TASK_PATH;
  const rows = await pathRepo.findAgentsByTreePaths(
    rootId,
    caller.userId,
    [path, ownerPath],
    ownerPath === ROOT_TASK_PATH
  );
  const exact = rows.find((row) => row.taskPath === path);
  if (exact !== undefined) {
    return { agent_id: exact.id, recipient_task_id: null, path, type: 'agent' };
  }
  const owner = rows.find((row) =>
    ownerPath === ROOT_TASK_PATH ? row.id === rootId : row.taskPath === ownerPath
  );
  const task =
    owner !== undefined ? listedBackgroundTasks(owner).find((t) => t.path === path) : undefined;
  if (owner === undefined || task === undefined) {
    return { error: `No agent or background task at ${path}`, status: 404 };
  }
  return { agent_id: owner.id, recipient_task_id: task.address, path, type: task.type };
}

async function resolveOwnerTask(
  caller: AddressCaller,
  ownerId: string,
  taskId: string
): Promise<ResolvedAddress | ServiceError> {
  const owner = await resolveAgentId(caller, ownerId, ownerId);
  if ('error' in owner) return owner;
  const [row] = await treeRepo.findTreeNodesByIds([ownerId]);
  const task = listedBackgroundTasks(row).find((t) => t.address === taskId);
  if (task === undefined) {
    return { error: `No background task ${taskId} on agent ${ownerId}`, status: 404 };
  }
  return { agent_id: ownerId, recipient_task_id: taskId, path: task.path ?? null, type: task.type };
}

export async function resolveTreeAddress(
  caller: AddressCaller,
  rawAddress: string
): Promise<ResolvedAddress | ServiceError> {
  const address = rawAddress.trim();
  if (address === 'parent') {
    if (caller.parentAgentId === null) {
      return { error: 'You are the root agent; you have no parent.', status: 404 };
    }
    return resolveAgentId(caller, caller.parentAgentId, address);
  }
  if (address === ROOT_TASK_PATH) return resolveAgentId(caller, rootOf(caller), address);
  if (UUID_PATTERN.test(address)) return resolveAgentId(caller, address.toLowerCase(), address);
  if (isTaskPath(address)) return resolvePath(caller, address);
  const ownerTask = OWNER_TASK_PATTERN.exec(address);
  if (ownerTask !== null) return resolveOwnerTask(caller, ownerTask[1].toLowerCase(), ownerTask[2]);
  return {
    error: `Unrecognized address "${address.slice(0, 80)}": use a path like /root/name, "parent", or an agent id`,
    status: 400,
  };
}
