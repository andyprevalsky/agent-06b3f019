export { CloudMessageBindingConflictError } from './types';
import { createHash } from 'node:crypto';
import { createLogger } from '../../providers/logger';
import {
  createQueueEntry,
  findImessageBridgeLastSeen,
  findQueueEntryForUser,
  findRecentInboundMessages,
  popOldestForUser,
  recordQueueDeliveryResult,
  markImessageBridgeSeen,
} from './repo';
import {
  CloudMessageEligibilityError,
  type MessageChannel,
  type RecentInboundMessage,
} from './types';
import { cloudMessageEligible } from './repo.cloud';
import { cloudMessageStatus } from './cloudMessage';
export { bindCloudMessage } from './repo.cloud';

const log = createLogger('iMessage');
const BRIDGE_FRESHNESS_MS = 45_000;

/**
 * Fetch recent inbound messages for a user, mapped to the agent-facing shape.
 * Optionally scoped to a single channel (e.g. IMESSAGE for the OTP relay).
 */
export async function fetchRecentInboundMessages(params: {
  userId: string;
  since: Date;
  limit: number;
  channel?: MessageChannel;
}): Promise<RecentInboundMessage[]> {
  const rows = await findRecentInboundMessages(params);
  return rows.map((row) => ({
    id: row.id,
    from: row.from,
    to: row.to,
    body: row.message,
    channel: row.channel,
    date: row.timestamp,
    personId: row.personId,
  }));
}

/**
 * Validate and queue an iMessage for sending via the Mac app.
 * Returns the created queue entry.
 */
export async function queueMessage(
  userId: string,
  agentId: string,
  phoneNumber: string,
  message: string,
  idempotencyKey?: unknown
) {
  if (!userId || !agentId || !phoneNumber || !message) {
    throw new ValidationError('user_id, agent_id, phone_number, and message are required');
  }

  // Validate phone number format (basic E.164 check)
  if (!phoneNumber.match(/^\+[1-9]\d{1,14}$/)) {
    throw new ValidationError('phone_number must be in E.164 format (e.g., +19729777432)');
  }

  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' || !idempotencyKey.match(/^[A-Za-z0-9_-]{1,200}$/))
  ) {
    throw new ValidationError(
      'idempotency_key must be 1-200 letters, numbers, underscores, or hyphens'
    );
  }

  const id =
    idempotencyKey === undefined
      ? undefined
      : `imq_${createHash('sha256')
          .update(`${userId}\0${agentId}\0${idempotencyKey}`)
          .digest('hex')}`;
  let transport = 'mac';
  try {
    if (await cloudMessageEligible(userId, agentId)) transport = 'phone_harness';
  } catch (error) {
    if (!(error instanceof CloudMessageEligibilityError)) throw error;
    throw new ValidationError(error.message);
  }
  const entry = await createQueueEntry(
    userId,
    agentId,
    phoneNumber,
    message,
    id,
    undefined,
    transport
  );

  if (
    entry.userId !== userId ||
    entry.agentId !== agentId ||
    entry.phoneNumber !== phoneNumber ||
    entry.message !== message
  ) {
    throw new IdempotencyConflictError();
  }

  log.info('Queued for sending', {
    id: entry.id,
    userId,
    agentId,
    phone: phoneNumber.substring(0, 4) + '****',
  });

  const bridge =
    entry.transport === 'phone_harness'
      ? { connected: false, lastSeenAt: null }
      : await getImessageBridgeStatus(userId);
  return { entry, bridge };
}

/**
 * Pop the next pending iMessage for the given user.
 * Returns null if no messages are queued.
 */
export async function popNextMessage(userId: string, supportsAcknowledgements: boolean) {
  const message = await popOldestForUser(userId, supportsAcknowledgements);

  if (message !== null) {
    log.info('Popped for sending', {
      id: message.id,
      phone: message.phoneNumber.substring(0, 4) + '****',
    });
  }

  return message;
}

export async function recordDeliveryResult(
  userId: string,
  queueId: string,
  claimToken: unknown,
  success: unknown,
  error: unknown
) {
  if (typeof claimToken !== 'string' || claimToken.length === 0) {
    throw new ValidationError('claim_token is required');
  }
  if (typeof success !== 'boolean') {
    throw new ValidationError('success must be a boolean');
  }
  if (error !== undefined && typeof error !== 'string') {
    throw new ValidationError('error must be a string');
  }
  const row = await recordQueueDeliveryResult({
    userId,
    id: queueId,
    claimToken,
    success,
    error: typeof error === 'string' ? error.slice(0, 1000) : undefined,
  });
  if (row.kind === 'not_found') throw new QueueEntryNotFoundError();
  if (row.kind === 'stale_claim') throw new StaleQueueClaimError();

  log.info('Recorded delivery result', {
    id: queueId,
    success,
    attempts: row.entry.attempts,
  });
  return row.entry;
}

export async function getDeliveryStatus(userId: string, queueId: string) {
  const row = await findQueueEntryForUser(userId, queueId);
  if (row === null) throw new QueueEntryNotFoundError();
  const status =
    row.transport === 'phone_harness'
      ? cloudMessageStatus(row)
      : row.sentAt
        ? 'sent'
        : row.failedAt
          ? 'failed'
          : row.dispatchedAt
            ? 'legacy_dispatched'
            : row.claimedAt
              ? 'sending'
              : row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()
                ? 'expired'
                : 'queued';
  return {
    ...(row.transport === 'phone_harness'
      ? { provider: 'phone_harness', browserTaskId: row.phoneBrowserTaskId }
      : {}),
    status,
    sentAt: row.sentAt,
    failedAt: row.failedAt,
    lastError: row.lastError,
    attempts: row.attempts,
    failures: row.failures,
  };
}

export async function recordImessageBridgeHeartbeat(userId: string) {
  await markImessageBridgeSeen(userId, new Date());
}

export async function getImessageBridgeStatus(userId: string) {
  const user = await findImessageBridgeLastSeen(userId);
  const lastSeenAt = user?.imessageBridgeLastSeenAt ?? null;
  return {
    connected: lastSeenAt !== null && Date.now() - lastSeenAt.getTime() <= BRIDGE_FRESHNESS_MS,
    lastSeenAt,
  };
}

// --- Error classes ---

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('idempotency_key was already used for a different iMessage payload');
    this.name = 'IdempotencyConflictError';
  }
}

export class QueueEntryNotFoundError extends Error {
  constructor() {
    super('iMessage queue entry not found');
    this.name = 'QueueEntryNotFoundError';
  }
}

export class StaleQueueClaimError extends Error {
  constructor() {
    super('iMessage delivery result does not match the current queue claim');
    this.name = 'StaleQueueClaimError';
  }
}
