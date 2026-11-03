/**
 * kill_agent for agent-to-agent tools. Addresses resolve through
 * agentAddressResolver.ts (same tree and owner only).
 *
 *   POST /:sender/kill-agent {to}
 *        ├─ to = sender                 → 400 (finish with attempt_completion)
 *        ├─ to not below sender          → 403 (only descendants can be killed)
 *        ├─ to = task of a descendant    → signal owner `kill` {task_id}
 *        ├─ to = finished descendant     → { killed: false, status }
 *        └─ to = running descendant      → signal target `kill` {by_agent_id}
 *              target cancels its step and fails through its normal failure
 *              path (error_reason "Killed by <sender path>"); its background
 *              tasks and children stop via the parent_finished cascade ("Killed
 *              by … (parent … was killed)"); its parent gets child_completed failed.
 *
 * A caller's own background tasks are killed inside its own workflow; this
 * endpoint is for agents in its subtree. 10k agents: one resolver read, an
 * ancestor walk bounded by tree depth (primary-key reads), one signal.
 */

import { signalAgentControl } from '../../providers/agentControlSignals';
import { createLogger } from '../../providers/logger';
import type { AgentKillBody } from './types';
import * as repo from './repoAgentMessages';
import * as treeRepo from './repoAgentTree';
import { agentTaskPath } from './agentTaskPath';
import { type ResolvedAddress, resolveTreeAddress } from './agentAddressResolver';
import { WAKEABLE_TERMINAL_STATUSES } from './agentWakeService';

const log = createLogger('AgentControl');

const MAX_ANCESTOR_LEVELS = 64;

type ServiceError = { error: string; status: number };

export interface KillAgentResult {
  killed: boolean;
  status: string;
  to: ResolvedAddress;
  message: string;
}

/** True when `agentId` sits strictly below `ancestorId` (bounded parent walk). */
export async function isDescendantOf(agentId: string, ancestorId: string): Promise<boolean> {
  let current: string | null = agentId;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS && current !== null; level += 1) {
    const [row] = await treeRepo.findTreeNodesByIds([current]);
    if (row === undefined) return false;
    if (row.parentAgentId === ancestorId) return true;
    current = row.parentAgentId;
  }
  return false;
}

async function senderFor(senderId: string, userId: string | undefined) {
  const [sender] = await repo.findAgentsForTreeAuth([senderId]);
  if (sender === undefined || sender.deletedAt !== null) return null;
  if (userId !== undefined && sender.userId !== userId) return null;
  return sender;
}

/** Kill one agent (and its subtree) or one background task below the sender. */
export async function killAgentByAddress(
  senderId: string,
  body: AgentKillBody,
  userId: string | undefined
): Promise<KillAgentResult | ServiceError> {
  const sender = await senderFor(senderId, userId);
  if (sender === null) return { error: 'Agent not found', status: 404 };
  const to = await resolveTreeAddress(sender, body.to);
  if ('error' in to) return to;
  if (to.agent_id === sender.id && to.recipient_task_id === null) {
    return {
      error: 'You cannot kill yourself; finish with attempt_completion instead.',
      status: 400,
    };
  }
  if (to.agent_id === sender.id) {
    return { error: 'Kill your own background tasks from your own workflow.', status: 400 };
  }
  if (!(await isDescendantOf(to.agent_id, sender.id))) {
    return {
      error: `${body.to} is not below you: kill_agent only kills your own descendants and background tasks.`,
      status: 403,
    };
  }
  const [target] = await repo.findAgentsForTreeAuth([to.agent_id]);
  if (target === undefined) return { error: `No agent at ${body.to}`, status: 404 };
  if (to.recipient_task_id === null && WAKEABLE_TERMINAL_STATUSES.includes(target.status)) {
    return { killed: false, status: target.status, to, message: `${body.to} already finished.` };
  }
  if (target.temporalWorkflowId === null) {
    return { error: `${body.to} has no running workflow to kill.`, status: 409 };
  }
  const payload = {
    by_agent_id: sender.id,
    by_agent_path: agentTaskPath(sender),
    idempotency_key: body.idempotency_key,
    ...(to.recipient_task_id !== null ? { task_id: to.recipient_task_id } : {}),
  };
  const delivered = await signalAgentControl(target.id, target.temporalWorkflowId, 'kill', payload);
  log.info('kill_agent signaled', {
    agent_id: target.id,
    by_agent_id: sender.id,
    task_id: to.recipient_task_id,
    delivered,
  });
  if (!delivered) return { error: `Could not reach ${body.to}; try again.`, status: 502 };
  return {
    killed: true,
    status: 'KILLING',
    to,
    message: `Kill requested for ${body.to}${to.recipient_task_id !== null ? '' : ' and everything below it'}.`,
  };
}
