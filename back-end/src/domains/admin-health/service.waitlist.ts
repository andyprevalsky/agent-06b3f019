import { markOffWaitlistByPhone } from '../../providers/inviteGate';
import { createLogger } from '../../providers/logger';
import { sendSms } from '../../providers/smsQueue';
import { sendTransactionalEmail } from '../../providers/transactionalEmail';
import {
  IS_PRODUCTION,
  WAITLIST_INVITE_COPY,
  WAITLIST_INVITE_EMAIL_FROM,
  WAITLIST_INVITE_EMAIL_FROM_NAME,
  WAITLIST_INVITE_EMAIL_SENDER_USER_ID,
  WAITLIST_INVITE_EMAIL_SUBJECT,
} from './config';
import * as repo from './repo';
import type { AdminWaitlistInviteResponse, AdminWaitlistPeopleResponse } from './types';

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

export interface WaitlistInviteDependencies {
  isProduction: boolean;
  now: () => Date;
  sendSms: typeof sendSms;
  sendEmail: typeof sendTransactionalEmail;
}

const WAITLIST_INVITE_DEPENDENCIES: WaitlistInviteDependencies = {
  isProduction: IS_PRODUCTION,
  now: () => new Date(),
  sendSms,
  sendEmail: sendTransactionalEmail,
};

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
  dependencies: WaitlistInviteDependencies = WAITLIST_INVITE_DEPENDENCIES
): Promise<AdminWaitlistInviteResponse> {
  const person = await repo.findWaitlistPersonById(id);
  if (person === null) throw new WaitlistPersonNotFoundError();

  const offWaitlist = await markOffWaitlistByPhone(person.phone);
  const accountEmail =
    offWaitlist.userId === null ? null : await repo.findUserEmailById(offWaitlist.userId);
  const recipientEmail = preferredRecipientEmail(person.email, accountEmail);

  // The local DB is seeded with production waitlist rows, so only production
  // may contact recipients.
  let smsSent = false;
  let emailSent = false;
  if (dependencies.isProduction) {
    const sms = await dependencies.sendSms(person.phone, WAITLIST_INVITE_COPY, {
      archiveContext: { source: 'admin-health-waitlist-invite', waitlist_id: id },
    });
    if (!sms.success) {
      throw new WaitlistInviteSmsError(sms.error ?? 'unknown error');
    }
    smsSent = true;

    if (recipientEmail !== null) {
      try {
        await dependencies.sendEmail({
          ownerUserId: WAITLIST_INVITE_EMAIL_SENDER_USER_ID,
          from: WAITLIST_INVITE_EMAIL_FROM,
          fromName: WAITLIST_INVITE_EMAIL_FROM_NAME,
          to: recipientEmail,
          subject: WAITLIST_INVITE_EMAIL_SUBJECT,
          body: WAITLIST_INVITE_COPY,
        });
        emailSent = true;
      } catch (error) {
        throw new WaitlistInviteEmailError(error instanceof Error ? error.message : String(error));
      }
    } else {
      log.warn('Skipping waitlist invite email: no email on file', { waitlistId: id });
    }
  } else {
    log.info('Skipping waitlist invite notifications outside production', { waitlistId: id });
  }

  const invitedAt = dependencies.now();
  await repo.markWaitlistInvited(id, invitedAt);

  return {
    id,
    invitedAt: invitedAt.toISOString(),
    smsSent,
    emailSent,
    flagged: offWaitlist.flagged,
    alreadyOffWaitlist: offWaitlist.alreadyOffWaitlist,
    hasAccount: offWaitlist.userId !== null,
  };
}
