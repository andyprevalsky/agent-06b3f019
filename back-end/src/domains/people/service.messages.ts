/**
 * People domain — message-related service functions.
 * Split from service.ts for max-lines compliance.
 */

import * as repo from './repo';
import type { FormattedMessage, PersonMatch } from './types';
import {
  DEFAULT_MESSAGE_LIMIT,
  DEFAULT_RECENT_DAYS,
  MAX_RECENT_DAYS,
  DEFAULT_RECENT_LIMIT,
} from './config';
import { ValidationError } from './service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePhone(p: string): string {
  return p.replace(/[^\d+]/g, '');
}

interface PersonMessageBody {
  user_id?: string;
  phone?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  message_limit?: string | number;
}

function resolveIdentifiers(body: PersonMessageBody) {
  const { phone, email, firstName, lastName } = body;

  const hasPhone =
    phone !== undefined && phone !== null && typeof phone === 'string' && phone.trim().length > 0;
  const hasEmail =
    email !== undefined && email !== null && typeof email === 'string' && email.trim().length > 0;
  const hasFirstName =
    firstName !== undefined &&
    firstName !== null &&
    typeof firstName === 'string' &&
    firstName.trim().length > 0;
  const hasLastName =
    lastName !== undefined &&
    lastName !== null &&
    typeof lastName === 'string' &&
    lastName.trim().length > 0;
  const hasName = hasFirstName;

  return {
    phone,
    email,
    firstName,
    lastName,
    hasPhone,
    hasEmail,
    hasFirstName,
    hasLastName,
    hasName,
  };
}

function buildWhereConditions(
  ids: ReturnType<typeof resolveIdentifiers>
): Record<string, unknown>[] {
  const whereConditions: Record<string, unknown>[] = [];

  if (ids.hasPhone) {
    const normalizedPhone = normalizePhone(ids.phone!);
    whereConditions.push({ phoneNumber: normalizedPhone });
  }
  if (ids.hasEmail) {
    whereConditions.push({ email: { equals: ids.email!, mode: 'insensitive' } });
  }
  if (ids.hasName) {
    const nameCondition: Record<string, unknown> = {
      firstName: { equals: ids.firstName!, mode: 'insensitive' },
    };
    if (ids.hasLastName) {
      nameCondition.lastName = { equals: ids.lastName!, mode: 'insensitive' };
    }
    whereConditions.push(nameCondition);
  }

  return whereConditions;
}

function buildPersonIdentifier(ids: ReturnType<typeof resolveIdentifiers>): string {
  if (ids.hasName) {
    return ids.hasLastName ? `${ids.firstName} ${ids.lastName}` : ids.firstName!;
  }
  if (ids.hasEmail) {
    return ids.email!;
  }
  return ids.phone!;
}

function formatMessages(
  records: Array<{ channel: string; from: string; to: string; timestamp: Date; message: string }>
): FormattedMessage[] {
  return records.map((record) => ({
    channel: record.channel,
    from: record.from,
    to: record.to,
    timestamp: record.timestamp.toISOString(),
    message: record.message,
  }));
}

// ---------------------------------------------------------------------------
// Messages for a person
// ---------------------------------------------------------------------------

export async function getPersonMessages(userId: string, body: PersonMessageBody) {
  const ids = resolveIdentifiers(body);

  if (!ids.hasPhone && !ids.hasEmail && !ids.hasName) {
    throw new ValidationError('At least one identifier is required: phone, email, or firstName');
  }

  const whereConditions = buildWhereConditions(ids);
  const personIdentifier = buildPersonIdentifier(ids);

  const matchingPeople = await repo.findMatchingPeople(userId, whereConditions);

  if (matchingPeople.length === 0) {
    return {
      person: null,
      messages: [],
      message: `No person found matching: ${personIdentifier}`,
    };
  }

  if (matchingPeople.length > 1) {
    const idType = ids.hasName ? 'name' : ids.hasEmail ? 'email' : 'phone';
    const matches: PersonMatch[] = matchingPeople.map((p) => ({
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      phoneNumber: p.phoneNumber,
      email: p.email,
      messageCount: p._count.messageRecords,
    }));
    return {
      person: null,
      messages: [],
      multiple_matches: true,
      message: `Multiple people found with the ${idType}: ${personIdentifier}`,
      matches,
    };
  }

  const messageLimit = parseInt(String(body.message_limit), 10);
  const resolvedLimit = Number.isNaN(messageLimit) ? DEFAULT_MESSAGE_LIMIT : messageLimit;
  const person = await repo.findPersonWithMessages(matchingPeople[0].id, resolvedLimit);

  if (person === null || person === undefined) {
    return {
      person: null,
      messages: [],
      message: `No person found matching: ${personIdentifier}`,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring to omit messageRecords
  const { messageRecords, ...personRow } = person;
  const personData = Object.fromEntries(
    Object.entries(personRow).filter(([_, v]) => v !== null && v !== undefined)
  );

  if (person.messageRecords.length === 0) {
    return {
      person: personData,
      messages: [],
      message: `No messages present for ${person.firstName} ${person.lastName}`,
    };
  }

  const formattedMessages = formatMessages(person.messageRecords);

  return {
    person: personData,
    messages: formattedMessages,
    count: formattedMessages.length,
  };
}

// ---------------------------------------------------------------------------
// Recent messages across all people
// ---------------------------------------------------------------------------

export async function getRecentMessages(userId: string, opts: { limit?: number; days?: number }) {
  const limit = opts.limit !== undefined && opts.limit !== null ? opts.limit : DEFAULT_RECENT_LIMIT;
  const rawDays = opts.days !== undefined && opts.days !== null ? opts.days : DEFAULT_RECENT_DAYS;
  const days = Math.min(Math.max(rawDays, 1), MAX_RECENT_DAYS);

  const cutoffTime = new Date();
  cutoffTime.setDate(cutoffTime.getDate() - days);

  const messages = await repo.findRecentMessages(userId, cutoffTime, limit);

  const formattedMessages = formatMessages(messages);

  return {
    messages: formattedMessages,
    count: formattedMessages.length,
    days,
  };
}
