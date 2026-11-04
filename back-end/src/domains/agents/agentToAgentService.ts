/**
 * Agent-to-agent messaging inside one agent tree.
 *
 *   sender ──POST /:target/agent-messages──▶ authorize (same user + same root)
 *                                              │
 *                       USER row on target (deterministic id = idempotency)
 *                                              │
 *            running code task? ──yes──▶ the live CLI's next user turn
 *                                              │      (deliverToRunningCodeTask), nothing stored
 *            recipient_task_id? ──yes──▶ excludeFromModel, no signal
 *                                              │      (other sender: task_running reported;
 *                                              │       a finished task: signal the owner
 *                                              │       {wake_task_id}, it starts the next run)
 *                                              │      (explore/browser activity polls
 *                                              │       GET /:target/agent-inbox)
 *                                              no
 *                                              ▼
 *                       target running ──▶ signal receive_agent_message {message_id}
 *                       target finished ──▶ wake: the message is its next task
 *                                       (agentWakeService.ts)
 *
 * A tree is identified by its root agent id: the root's own id, which every
 * descendant carries as `busId`. Membership is one primary-key lookup; no
 * ancestor walk. Agent messages never lift a user pause and never count as
 * user response-schema feedback.
 */

import { createMessage } from '../../providers/messages';
import { signalAgentMessage } from '../../providers/agentResume';
import { createLogger } from '../../providers/logger';
import type { AgentAddressMessageBody, AgentInboxQuery, AgentMessageBody } from './types';
import * as repo from './repoAgentMessages';
import { agentTaskPath, rootOf } from './agentTaskPath';
import { type ResolvedAddress, resolveTreeAddress } from './agentAddressResolver';
import { listedBackgroundTasks } from './agentTreeBackgroundTasks';
import { WAKEABLE_TERMINAL_STATUSES, wakeFinishedAgent } from './agentWakeService';
import { guardAgentMessage, noteAgentMessagesConsumed } from './agentMessageGuardService';
import { taskMessageRefusal } from './agentTaskMessageRefusal';
import { sendAgentMessageToRunningCodeTask } from './agentCodeTurnDelivery';

const log = createLogger('AgentMessages');

const FROM_GOAL_MAX_CHARS = 200;
const ENDED_STATUSES = WAKEABLE_TERMINAL_STATUSES;

export interface AgentMessageOptions {
  /** The address the sender used (shown in guard refusals); defaults to the target's path. */
  displayAddress?: string;
}

export interface AgentMessageDeliveryResult {
  message_id: string;
  delivered: boolean;
  task_running?: boolean;
  /** The target had finished; this message started its next run. */
  woke?: boolean;
  wake_error?: string;
}

type ServiceError = { error: string; status: number };
type TreeAgent = Awaited<ReturnType<typeof repo.findAgentsForTreeAuth>>[number];

/** Owner check for user-scoped callers; internal callers without a user id pass. */
function visibleTo(agent: TreeAgent, userId: string | undefined): boolean {
  return agent.deletedAt === null && (userId === undefined || agent.userId === userId);
}

async function resolveSameTree(
  targetId: string,
  senderId: string,
  userId: string | undefined
): Promise<{ target: TreeAgent; sender: TreeAgent } | ServiceError> {
  const rows = await repo.findAgentsForTreeAuth([targetId, senderId]);
  const target = rows.find((row) => row.id === targetId);
  const sender = rows.find((row) => row.id === senderId);
  if (target === undefined || !visibleTo(target, userId)) {
    return { error: 'Agent not found', status: 404 };
  }
  if (
    sender === undefined ||
    !visibleTo(sender, userId) ||
    sender.userId !== target.userId ||
    rootOf(sender) !== rootOf(target)
  ) {
    return { error: 'Sender and target must be in the same agent tree', status: 403 };
  }
  return { target, sender };
}

/**
 * How one message is delivered and what the recipient's model sees (Codex
 * InterAgentMessage): NEW_TASK wakes a finished agent with it, MESSAGE is
 * read at its next step. `toAgentPath`
 * is the recipient's task path ("Task name").
 */
function deliveryShape(target: TreeAgent, sender: TreeAgent, body: AgentMessageBody) {
  const addressedToTask = body.recipient_task_id !== undefined;
  // Another agent addressing `<owner>/<task>` from list_agents: report whether
  // the task is still in flight on the owner (persisted tree state). The row is
  // stored either way; the sender learns when nothing will read it. The owner's
  // own task messages are checked by its workflow.
  const recipientTask = addressedToTask
    ? listedBackgroundTasks(target).find((task) => task.address === body.recipient_task_id)
    : undefined;
  const recipientTaskRunning = recipientTask?.status === 'running';
  const taskRunning = addressedToTask && sender.id !== target.id ? recipientTaskRunning : undefined;
  const wakesFinishedAgent =
    !addressedToTask &&
    target.temporalWorkflowId !== null &&
    ENDED_STATUSES.includes(target.status);
  // A finished explore/browser/code task is woken by its owner's workflow: the
  // owner itself (its own send) or, for another sender, a signal from here.
  const wakesFinishedTask = recipientTask !== undefined && !recipientTaskRunning;
  const messageType = wakesFinishedAgent || wakesFinishedTask ? 'NEW_TASK' : 'MESSAGE';
  const toAgentPath = addressedToTask ? (recipientTask?.path ?? null) : agentTaskPath(target);
  return {
    recipientTask,
    addressedToTask,
    taskRunning,
    wakesFinishedAgent,
    wakesFinishedTask,
    messageType,
    toAgentPath,
  };
}

/** Ask a running owner to start the next run of its finished task (owner workflow dedupes by message id). */
async function wakeFinishedTaskOwner(
  owner: TreeAgent,
  sender: TreeAgent,
  messageId: string,
  body: AgentMessageBody
): Promise<{ woke: boolean; reason?: string }> {
  if (ENDED_STATUSES.includes(owner.status)) {
    return { woke: false, reason: 'its owner agent has finished' };
  }
  if (owner.temporalWorkflowId === null) {
    return { woke: false, reason: 'its owner agent is not running' };
  }
  const signalled = await signalAgentMessage(owner.id, owner.temporalWorkflowId, messageId, {
    from_agent_id: sender.id,
    from_agent_path: agentTaskPath(sender),
    wake_task_id: body.recipient_task_id,
    message: body.message,
    ...(body.continue_conversation !== undefined
      ? { continue_conversation: body.continue_conversation }
      : {}),
  });
  return signalled
    ? { woke: true }
    : { woke: false, reason: 'its owner agent could not be reached' };
}

/**
 * Why a message is refused before anything is stored, or null. Reads only the
 * already-loaded target row (its persisted task list): no extra query.
 */
async function refusalBeforeStore(
  target: TreeAgent,
  sender: TreeAgent,
  body: AgentMessageBody,
  options: AgentMessageOptions,
  { recipientTask, toAgentPath }: ReturnType<typeof deliveryShape>
): Promise<ServiceError | null> {
  const taskRefusal = taskMessageRefusal(
    recipientTask,
    options.displayAddress ?? toAgentPath ?? body.recipient_task_id ?? target.id,
    body.continue_conversation
  );
  if (taskRefusal !== null) return taskRefusal;
  // Prime-style guard: per-sender rate + per-recipient unread cap (retries are free).
  return guardAgentMessage(
    target,
    sender.id,
    body.recipient_task_id ?? null,
    body.idempotency_key,
    options.displayAddress ?? toAgentPath ?? agentTaskPath(target) ?? target.id
  );
}

/**
 * A running code task is a CLI, not an inbox reader: the message is its next
 * user turn or the refusal (agentCodeTurnDelivery.ts). No inbox row is
 * written, so the unread guard does not apply; that path keeps the send budget.
 */
function runningCodeTaskDelivery(
  owner: TreeAgent,
  sender: TreeAgent,
  body: AgentMessageBody,
  task: ReturnType<typeof deliveryShape>['recipientTask']
): ReturnType<typeof sendAgentMessageToRunningCodeTask> | null {
  if (task?.type !== 'code' || task.status !== 'running') return null;
  return sendAgentMessageToRunningCodeTask({
    ownerAgentId: owner.id,
    taskAddress: body.recipient_task_id ?? '',
    runStartedAt: task.started_at ?? null,
    sender: { id: sender.id, label: agentTaskPath(sender) ?? 'Agent' },
    idempotencyKey: body.idempotency_key,
    text: body.message,
  });
}

/** Persist one agent message on the target and wake the target's workflow. */
export async function sendAgentMessage(
  targetId: string,
  body: AgentMessageBody,
  userId: string | undefined,
  options: AgentMessageOptions = {}
): Promise<AgentMessageDeliveryResult | ServiceError> {
  const resolved = await resolveSameTree(targetId, body.from_agent_id, userId);
  if ('error' in resolved) return resolved;
  const { target, sender } = resolved;
  const shape = deliveryShape(target, sender, body);
  const {
    addressedToTask,
    taskRunning,
    wakesFinishedAgent,
    wakesFinishedTask,
    messageType,
    toAgentPath,
  } = shape;
  const codeTask = runningCodeTaskDelivery(target, sender, body, shape.recipientTask);
  if (codeTask !== null) return codeTask;
  const refused = await refusalBeforeStore(target, sender, body, options, shape);
  if (refused !== null) return refused;

  const message = await createMessage({
    agentId: target.id,
    text: body.message,
    role: 'USER',
    metadata: {
      agentMessage: true,
      fromAgentId: sender.id,
      fromAgentPath: agentTaskPath(sender),
      fromGoal: sender.goal.slice(0, FROM_GOAL_MAX_CHARS),
      toAgentPath,
      messageType,
      idempotencyKey: body.idempotency_key,
      ...(addressedToTask
        ? { recipientTaskId: body.recipient_task_id, excludeFromModel: true }
        : {}),
    },
  });

  // Task-addressed rows are read by the target's activity inbox poll; the
  // target's own LLM never sees them, so its workflow is not woken — except
  // to start the next run of a finished task another agent messaged.
  let delivered = false;
  let wake: Awaited<ReturnType<typeof wakeFinishedAgent>> | undefined;
  if (wakesFinishedTask && sender.id !== target.id) {
    wake = await wakeFinishedTaskOwner(target, sender, message.id, body);
    delivered = wake.woke;
  }
  if (!addressedToTask && target.temporalWorkflowId !== null) {
    const senderIdentity = { from_agent_id: sender.id, from_agent_path: agentTaskPath(sender) };
    if (wakesFinishedAgent) {
      wake = await wakeFinishedAgent(target.id, message.id, body.message);
      delivered = wake.woke;
    } else {
      delivered = await signalAgentMessage(
        target.id,
        target.temporalWorkflowId,
        message.id,
        senderIdentity
      );
    }
  }

  log.info('agent message stored', {
    agent_id: target.id,
    from_agent_id: sender.id,
    message_id: message.id,
    recipient_task_id: body.recipient_task_id ?? null,
    delivered,
    woke: wake?.woke ?? null,
  });
  return {
    message_id: message.id,
    delivered,
    ...(taskRunning !== undefined ? { task_running: taskRunning } : {}),
    ...(wake !== undefined ? { woke: wake.woke } : {}),
    ...(wake !== undefined && !wake.woke && wake.reason !== undefined
      ? { wake_error: wake.reason }
      : {}),
  };
}

/**
 * Deliver one message addressed the way agents see their tree: a task path
 * ("/root/outreach/draft_a"), "parent", "/root", or an agent id. The address is
 * resolved within the sender's tree (agentAddressResolver.ts), then delivered
 * like POST /:target/agent-messages.
 */
export async function sendAgentMessageByAddress(
  senderId: string,
  body: AgentAddressMessageBody,
  userId: string | undefined
): Promise<(AgentMessageDeliveryResult & { to: ResolvedAddress }) | ServiceError> {
  const [sender] = await repo.findAgentsForTreeAuth([senderId]);
  if (sender === undefined || !visibleTo(sender, userId)) {
    return { error: 'Agent not found', status: 404 };
  }
  const to = await resolveTreeAddress(sender, body.to);
  if ('error' in to) return to;
  if (to.agent_id === sender.id && to.recipient_task_id === null) {
    return { error: 'You cannot send a message to yourself.', status: 400 };
  }
  const result = await sendAgentMessage(
    to.agent_id,
    {
      from_agent_id: sender.id,
      message: body.message,
      idempotency_key: body.idempotency_key,
      ...(to.recipient_task_id !== null ? { recipient_task_id: to.recipient_task_id } : {}),
      ...(body.continue_conversation !== undefined
        ? { continue_conversation: body.continue_conversation }
        : {}),
    },
    userId,
    { displayAddress: body.to }
  );
  return 'error' in result ? result : { ...result, to };
}

/** Resolve `address` relative to agent `agentId` (same tree and owner only). */
export async function resolveAddressForAgent(
  agentId: string,
  address: string,
  userId: string | undefined
): Promise<ResolvedAddress | ServiceError> {
  const [caller] = await repo.findAgentsForTreeAuth([agentId]);
  if (caller === undefined || !visibleTo(caller, userId)) {
    return { error: 'Agent not found', status: 404 };
  }
  return resolveTreeAddress(caller, address);
}

function metadataString(metadata: unknown, key: string): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Inbox rows for one task owned by `agentId`, after `since` (bounded indexed
 * read). Shared by GET /:id/agent-inbox and the explore progress post's
 * piggybacked read (POST /:id/messages {inbox} → pending_inbox).
 */
export async function readTaskInboxMessages(agentId: string, taskId: string, since?: Date) {
  const rows = await repo.findTaskInboxMessages(agentId, taskId, since);
  // The task's own read: these rows are now consumed (unread cap, agentMessageGuardService.ts).
  await noteAgentMessagesConsumed(
    agentId,
    rows.map((row) => ({ role: 'USER', timestamp: row.timestamp, metadata: row.metadata })),
    taskId
  );
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    from_agent_id: metadataString(row.metadata, 'fromAgentId'),
    from_agent_path: metadataString(row.metadata, 'fromAgentPath'),
    from_goal: metadataString(row.metadata, 'fromGoal'),
    to_agent_path: metadataString(row.metadata, 'toAgentPath'),
    message_type: metadataString(row.metadata, 'messageType'),
    created_at: row.timestamp,
  }));
}

/** Agent messages addressed to one task owned by `agentId`, after `since`. */
export async function getAgentTaskInbox(
  agentId: string,
  query: AgentInboxQuery,
  userId: string | undefined
) {
  const [agent] = await repo.findAgentsForTreeAuth([agentId]);
  if (agent === undefined || !visibleTo(agent, userId)) return null;
  return { messages: await readTaskInboxMessages(agentId, query.task_id, query.since) };
}
