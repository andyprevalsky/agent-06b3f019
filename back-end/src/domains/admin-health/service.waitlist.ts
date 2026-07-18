import { markOffWaitlistByPhone } from '../../providers/inviteGate';
import { createLogger } from '../../providers/logger';
import { sendSms } from '../../providers/smsQueue';
import {
  claimToolSideEffect,
  markToolSideEffectFailed,
  markToolSideEffectSucceeded,
  reclaimFailedToolSideEffect,
  type ToolSideEffectJson,
} from '../../providers/toolSideEffects';
import {
  sendTransactionalEmail,
  TransactionalEmailDefinitiveError,
} from '../../providers/transactionalEmail';
import {
  IS_PRODUCTION,
  WAITLIST_INVITE_COPY,
  WAITLIST_INVITE_EMAIL_FROM,
  WAITLIST_INVITE_EMAIL_FROM_NAME,
  WAITLIST_INVITE_EMAIL_SENDER_USER_ID,
  WAITLIST_INVITE_EMAIL_SUBJECT,
} from './config';
import * as repo from './repo';
import {
  finalizeWaitlistInviteOutcome,
  findStoredInviteFinalOutcome,
  WaitlistInviteInProgressError,
} from './service.waitlist-finalization';
import type { AdminWaitlistInviteResponse, AdminWaitlistPeopleResponse } from './types';

export {
  waitlistInviteFinalOperationKey,
  WaitlistInviteInProgressError,
} from './service.waitlist-finalization';

const log = createLogger('AdminHealthWaitlist');

export class WaitlistPersonNotFoundError extends Error {
  constructor() {
    super('Waitlist person not found');
    this.name = 'WaitlistPersonNotFoundError';
  }
}

export class WaitlistInviteSmsError extends Error {
  constructor(detail: string) {
    super(`Failed to send invite SMS: ${detail}`);
    this.name = 'WaitlistInviteSmsError';
  }
}

export class WaitlistInviteEmailError extends Error {
  constructor(detail: string) {
    super(`Failed to send invite email: ${detail}`);
    this.name = 'WaitlistInviteEmailError';
  }
}

export class WaitlistInviteIdempotencyKeyError extends Error {
  constructor() {
    super('Idempotency-Key must be 1-200 letters, numbers, underscores, or hyphens');
    this.name = 'WaitlistInviteIdempotencyKeyError';
  }
}

export interface WaitlistInviteDependencies {
  isProduction: boolean;
  now: () => Date;
  sendSms: typeof sendSms;
  sendEmail: typeof sendTransactionalEmail;
  markInvited?: typeof repo.markWaitlistInvited;
}

const WAITLIST_INVITE_DEPENDENCIES: WaitlistInviteDependencies = {
  isProduction: IS_PRODUCTION,
  now: () => new Date(),
  sendSms,
  sendEmail: sendTransactionalEmail,
};
const WAITLIST_INVITE_OPERATION_TYPE = 'admin-health.waitlist-invite';

function assertIdempotencyKey(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new WaitlistInviteIdempotencyKeyError();
  }
  return value;
}

function channelOperationKey(id: string, idempotencyKey: string, channel: 'sms' | 'email') {
  return `waitlist-invite:${id}:${idempotencyKey}:${channel}`;
}

async function claimInviteChannel(params: {
  id: string;
  idempotencyKey: string;
  channel: 'sms' | 'email';
  request: ToolSideEffectJson;
}): Promise<{ operationKey: string; shouldSend: boolean }> {
  const operationKey = channelOperationKey(params.id, params.idempotencyKey, params.channel);
  let claim = await claimToolSideEffect({
    operationKey,
    operationType: WAITLIST_INVITE_OPERATION_TYPE,
    request: params.request,
  });
  if (claim.status === 'existing' && claim.record.status === 'FAILED') {
    claim = await reclaimFailedToolSideEffect(operationKey);
  }
  if (claim.status === 'claimed') return { operationKey, shouldSend: true };
  if (claim.record.status === 'SUCCEEDED') return { operationKey, shouldSend: false };
  throw new WaitlistInviteInProgressError();
}

async function sendInviteSms(params: {
  id: string;
  idempotencyKey: string;
  phone: string;
  dependencies: WaitlistInviteDependencies;
}): Promise<void> {
  const delivery = await claimInviteChannel({
    id: params.id,
    idempotencyKey: params.idempotencyKey,
    channel: 'sms',
    request: { waitlistId: params.id, phone: params.phone },
  });
  if (!delivery.shouldSend) return;

  let sms: Awaited<ReturnType<typeof sendSms>>;
  try {
    sms = await params.dependencies.sendSms(params.phone, WAITLIST_INVITE_COPY, {
      archiveContext: { source: 'admin-health-waitlist-invite', waitlist_id: params.id },
    });
  } catch (error) {
    // A thrown transport error may follow provider acceptance, so retain the
    // STARTED claim and require a deliberate new idempotency key.
    throw new WaitlistInviteSmsError(error instanceof Error ? error.message : String(error));
  }
  if (!sms.success) {
    const wrapped = new WaitlistInviteSmsError(sms.error ?? 'unknown error');
    if (sms.definitiveFailure === true) {
      await markToolSideEffectFailed({
        operationKey: delivery.operationKey,
        error: wrapped.message,
      });
    }
    throw wrapped;
  }

  // Keep STARTED (fail closed) if this persistence write fails after provider acceptance.
  await markToolSideEffectSucceeded({
    operationKey: delivery.operationKey,
    externalId: sms.messageSid ?? delivery.operationKey,
    response: { success: true },
  });
}

async function sendInviteEmail(params: {
  id: string;
  idempotencyKey: string;
  recipient: string;
  dependencies: WaitlistInviteDependencies;
}): Promise<void> {
  const delivery = await claimInviteChannel({
    id: params.id,
    idempotencyKey: params.idempotencyKey,
    channel: 'email',
    request: { waitlistId: params.id, recipient: params.recipient },
  });
  if (!delivery.shouldSend) return;

  let email: Awaited<ReturnType<typeof sendTransactionalEmail>>;
  try {
    email = await params.dependencies.sendEmail({
      ownerUserId: WAITLIST_INVITE_EMAIL_SENDER_USER_ID,
      from: WAITLIST_INVITE_EMAIL_FROM,
      fromName: WAITLIST_INVITE_EMAIL_FROM_NAME,
      to: params.recipient,
      subject: WAITLIST_INVITE_EMAIL_SUBJECT,
      body: WAITLIST_INVITE_COPY,
    });
  } catch (error) {
    const wrapped = new WaitlistInviteEmailError(
      error instanceof Error ? error.message : String(error)
    );
    if (error instanceof TransactionalEmailDefinitiveError) {
      await markToolSideEffectFailed({
        operationKey: delivery.operationKey,
        error: wrapped.message,
      });
    }
    throw wrapped;
  }

  // Keep STARTED (fail closed) if this persistence write fails after provider acceptance.
  await markToolSideEffectSucceeded({
    operationKey: delivery.operationKey,
    externalId: email.id,
    response: { success: true },
  });
}

function normalizePhoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

/** Return every actionable phone-bearing waitlist signup with gate state. */
export async function getWaitlistPeople(): Promise<AdminWaitlistPeopleResponse> {
  const rows = await repo.findWaitlistPeople();
  const accounts = await repo.findAccountsByPhones(rows.map((row) => row.phone));
  const accountByDigits = new Map<string, repo.AccountGateRecord>();
  for (const account of accounts) {
    accountByDigits.set(normalizePhoneDigits(account.phone), account);
  }
  const people = rows.map((row) => {
    const account = accountByDigits.get(normalizePhoneDigits(row.phone));
    const hasAccount = account !== undefined;
    // Matches the real gate: a redeemed invite code OR an active subscription
    // clears it (offWaitlistAt alone does not).
    const isGated = hasAccount && account.usedInviteCode === null && !account.hasActiveSubscription;
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      variant: row.variant,
      joinedAt: row.createdAt.toISOString(),
      invitedAt: row.invitedAt === null ? null : row.invitedAt.toISOString(),
      hasAccount,
      isGated,
    };
  });
  return { people, total: people.length };
}

function preferredRecipientEmail(waitlistEmail: string | null, accountEmail: string | null) {
  const normalizedWaitlistEmail = waitlistEmail?.trim();
  return normalizedWaitlistEmail !== undefined && normalizedWaitlistEmail !== ''
    ? normalizedWaitlistEmail
    : accountEmail;
}

/**
 * Pull a person off the waitlist and send the same download copy by SMS and
 * email. Email is skipped only when neither the waitlist row nor account has
 * one on file. invitedAt is stamped after every available production channel
 * accepts the message so failures remain retryable.
 */
export async function inviteWaitlistPerson(
  id: string,
  dependencies: WaitlistInviteDependencies = WAITLIST_INVITE_DEPENDENCIES,
  idempotencyKeyValue?: string
): Promise<AdminWaitlistInviteResponse> {
  const idempotencyKey = assertIdempotencyKey(idempotencyKeyValue);
  const person = await repo.findWaitlistPersonById(id);
  if (person === null) throw new WaitlistPersonNotFoundError();

  const markInvited = dependencies.markInvited ?? repo.markWaitlistInvited;
  const storedFinalOutcome = await findStoredInviteFinalOutcome({
    id,
    idempotencyKey,
    markInvited,
  });
  if (storedFinalOutcome !== null) {
    return storedFinalOutcome;
  }

  const offWaitlist = await markOffWaitlistByPhone(person.phone);
  const accountEmail =
    offWaitlist.userId === null ? null : await repo.findUserEmailById(offWaitlist.userId);
  const recipientEmail = preferredRecipientEmail(person.email, accountEmail);

  // The local DB is seeded with production waitlist rows, so only production
  // may contact recipients.
  let smsSent = false;
  let emailSent = false;
  if (dependencies.isProduction) {
    await sendInviteSms({
      id,
      idempotencyKey,
      phone: person.phone,
      dependencies,
    });
    smsSent = true;

    if (recipientEmail !== null) {
      await sendInviteEmail({ id, idempotencyKey, recipient: recipientEmail, dependencies });
      emailSent = true;
    } else {
      log.warn('Skipping waitlist invite email: no email on file', { waitlistId: id });
    }
  } else {
    log.info('Skipping waitlist invite notifications outside production', { waitlistId: id });
  }

  const result: AdminWaitlistInviteResponse = {
    id,
    invitedAt: dependencies.now().toISOString(),
    smsSent,
    emailSent,
    flagged: offWaitlist.flagged,
    alreadyOffWaitlist: offWaitlist.alreadyOffWaitlist,
    hasAccount: offWaitlist.userId !== null,
  };
  return finalizeWaitlistInviteOutcome({ result, idempotencyKey, markInvited });
}
