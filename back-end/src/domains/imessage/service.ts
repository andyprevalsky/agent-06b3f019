import { createLogger } from '../../providers/logger';
import { createQueueEntry, findRecentInboundMessages, popOldestForUser } from './repo';
import type { MessageChannel, RecentInboundMessage } from './types';

const log = createLogger('iMessage');

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
  message: string
) {
  if (!userId || !agentId || !phoneNumber || !message) {
    throw new ValidationError('user_id, agent_id, phone_number, and message are required');
  }

  // Validate phone number format (basic E.164 check)
  if (!phoneNumber.match(/^\+[1-9]\d{1,14}$/)) {
    throw new ValidationError('phone_number must be in E.164 format (e.g., +19729777432)');
  }

  const entry = await createQueueEntry(userId, agentId, phoneNumber, message);

  log.info('Queued for sending', {
    id: entry.id,
    userId,
    agentId,
    phone: phoneNumber.substring(0, 4) + '****',
  });

  return entry;
}

/**
 * Pop the next pending iMessage for the given user.
 * Returns null if no messages are queued.
 */
export async function popNextMessage(userId: string) {
  const message = await popOldestForUser(userId);

  if (message !== null) {
    log.info('Popped for sending', {
      id: message.id,
      phone: message.phoneNumber.substring(0, 4) + '****',
    });
  }

  return message;
}

// --- Error classes ---

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
