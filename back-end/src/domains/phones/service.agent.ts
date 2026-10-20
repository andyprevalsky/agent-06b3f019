/**
 * Agent side of phone control: acquire / heartbeat / release a lease.
 *
 * Every agent phone operation (Phase 2 tools: screenshot, tap, type, swipe)
 * first passes `heartbeatForAgent`, so an agent whose control the user took
 * fails fast with PHONE_CONTROL_TAKEN and its exact, tool-visible message.
 * All calls are idempotent and safe under Temporal retries: a holder that
 * re-acquires keeps its leaseId, and releasing an unheld phone is a no-op.
 */
import { randomUUID } from '../../providers/crypto';
import { AGENT_HEARTBEAT_INTERVAL_MS, AGENT_LEASE_TTL_MS } from './config';
import * as repo from './repo';
import {
  CAS_ATTEMPTS,
  PhoneControlError,
  agentLabel,
  getPhone,
  isOnline,
  liveHolder,
  requirePhone,
  type LiveHolder,
} from './service';
import type { PhoneAgentLease, PhoneState } from './types';

const CONTROL_TAKEN_MESSAGE =
  'The user took control of this phone. Stop using it now. You can acquire it again after they hand it back.';

function blockedError(
  row: repo.PhoneDeviceRow,
  live: LiveHolder,
  agentId: string,
  holderTitle: string | null
): PhoneControlError {
  if (live.kind === 'user') {
    return row.resumeAgentId === agentId
      ? new PhoneControlError('PHONE_CONTROL_TAKEN', CONTROL_TAKEN_MESSAGE)
      : new PhoneControlError(
          'PHONE_IN_USE_BY_USER',
          'The user is controlling this phone. Try again after they hand it back.'
        );
  }
  const who = holderTitle !== null ? `"${holderTitle}"` : live.agentId;
  return new PhoneControlError(
    'PHONE_IN_USE_BY_AGENT',
    `Another agent (${who}) is using this phone. Try again after it finishes.`
  );
}

async function holderTitle(userId: string, live: LiveHolder): Promise<string | null> {
  if (live.kind !== 'agent') return null;
  const [agent] = await repo.findAgentLabels(userId, [live.agentId]);
  return agentLabel(agent);
}

function leaseReceipt(phoneId: string, leaseId: string, expiresAt: Date): PhoneAgentLease {
  return {
    phoneId,
    leaseId,
    leaseExpiresAt: expiresAt.toISOString(),
    heartbeatIntervalMs: AGENT_HEARTBEAT_INTERVAL_MS,
  };
}

/**
 * Acquire (or, for the current holder, renew) exclusive control for an agent.
 * Idempotent for Temporal retries: a holder re-acquiring keeps its leaseId.
 */
export async function acquireForAgent(
  userId: string,
  phoneId: string,
  agentId: string
): Promise<PhoneAgentLease> {
  if (!(await repo.findOwnedAgent(userId, agentId))) {
    throw new PhoneControlError('AGENT_NOT_FOUND', 'Agent not found', 404);
  }
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const row = await requirePhone(userId, phoneId);
    const now = new Date();
    const live = liveHolder(row, now);
    const expiresAt = new Date(now.getTime() + AGENT_LEASE_TTL_MS);
    if (live?.kind === 'agent' && live.agentId === agentId) {
      if (
        await repo.compareAndSetHolder(userId, phoneId, live.leaseId, { leaseExpiresAt: expiresAt })
      ) {
        return leaseReceipt(phoneId, live.leaseId, expiresAt);
      }
      continue;
    }
    if (live) throw blockedError(row, live, agentId, await holderTitle(userId, live));
    if (!isOnline(row, now)) {
      throw new PhoneControlError(
        'PHONE_OFFLINE',
        `The phone "${row.name}" is not connected. iPhone Mirroring must be open on the user's Mac with the Rose Mac app running.`
      );
    }
    const leaseId = randomUUID();
    const acquired = await repo.compareAndSetHolder(userId, phoneId, row.leaseId, {
      holderKind: 'agent',
      holderAgentId: agentId,
      leaseId,
      leaseExpiresAt: expiresAt,
      resumeAgentId: null,
    });
    if (acquired) return leaseReceipt(phoneId, leaseId, expiresAt);
  }
  throw new PhoneControlError(
    'PHONE_CONTROL_CONFLICT',
    'Phone control changed concurrently; retry'
  );
}

/**
 * Keep an agent's lease alive. Every agent phone operation goes through this
 * check, so a preempted agent fails fast with the exact tool error.
 */
export async function heartbeatForAgent(
  userId: string,
  phoneId: string,
  agentId: string,
  leaseId?: string
): Promise<PhoneAgentLease> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const row = await requirePhone(userId, phoneId);
    const now = new Date();
    const live = liveHolder(row, now);
    const holds =
      live?.kind === 'agent' &&
      live.agentId === agentId &&
      (leaseId === undefined || leaseId === live.leaseId);
    if (!holds) {
      if (live && !(live.kind === 'agent' && live.agentId === agentId)) {
        throw blockedError(row, live, agentId, await holderTitle(userId, live));
      }
      throw new PhoneControlError(
        'PHONE_LEASE_LOST',
        'Your control of this phone lapsed. Acquire it again before continuing.'
      );
    }
    const expiresAt = new Date(now.getTime() + AGENT_LEASE_TTL_MS);
    if (
      await repo.compareAndSetHolder(userId, phoneId, live.leaseId, { leaseExpiresAt: expiresAt })
    ) {
      return leaseReceipt(phoneId, live.leaseId, expiresAt);
    }
  }
  throw new PhoneControlError(
    'PHONE_LEASE_LOST',
    'Your control of this phone lapsed. Acquire it again before continuing.'
  );
}

/**
 * The agent is done with the phone. Idempotent: releasing a phone it does not
 * hold is a no-op; an agent waiting to resume gives up its resume claim.
 */
export async function releaseForAgent(
  userId: string,
  phoneId: string,
  agentId: string,
  leaseId?: string
): Promise<{ released: boolean; phone: PhoneState }> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const row = await requirePhone(userId, phoneId);
    const now = new Date();
    const live = liveHolder(row, now);
    const holds =
      row.holderKind === 'agent' &&
      row.holderAgentId === agentId &&
      (leaseId === undefined || leaseId === row.leaseId);
    if (holds) {
      const cleared = await repo.compareAndSetHolder(userId, phoneId, row.leaseId, {
        holderKind: null,
        holderAgentId: null,
        leaseId: null,
        leaseExpiresAt: null,
      });
      if (cleared) return { released: live !== null, phone: await getPhone(userId, phoneId) };
      continue;
    }
    if (row.resumeAgentId === agentId) {
      const cleared = await repo.compareAndSetHolder(userId, phoneId, row.leaseId, {
        resumeAgentId: null,
      });
      if (!cleared) continue;
    }
    return { released: false, phone: await getPhone(userId, phoneId) };
  }
  return { released: false, phone: await getPhone(userId, phoneId) };
}
