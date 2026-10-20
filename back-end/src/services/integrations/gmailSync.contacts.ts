/**
 * Parsed Gmail messages → ContactToUpsert rows for personMessageManager.
 *
 *   classification given (full-sync batch)  ─► the whole-mailbox decision: user
 *        addresses and contacts-written-to come from the scan, so a batch keeps
 *        exactly the messages the scan selected, whatever its position
 *   no classification (incremental set)     ─► per-set import detection + the
 *        stored "user has written to this contact" filter
 *
 * Every Gmail message carries `externalId = gmail:<address>:<gmail id>`, so a
 * resumed or repeated sync of the same message is a no-op insert.
 */

import { MessageChannel } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import type { MailboxClassification, ParsedEmail } from './gmailParser';
import { stripHtml } from './gmailParser.helpers';
import type { ContactToUpsert } from './personMessageManager';

const log = createLogger('GmailSync');

/** Dedup key of one Gmail message for one connected address. */
export function gmailExternalId(accountEmail: string, gmailId: string): string {
  return `gmail:${accountEmail.toLowerCase()}:${gmailId}`;
}

interface ContactAccumulator {
  email: string;
  name: string | null;
  sentCount: number;
  messages: ContactToUpsert['messages'];
}

/** The user's addresses: connected, SENT senders, and dominant imported senders. */
function detectUserEmails(emails: ParsedEmail[], userEmail: string): Set<string> {
  const userEmailSet = new Set<string>([userEmail.toLowerCase()]);
  for (const email of emails) {
    if (email.isSent) userEmailSet.add(email.from.toLowerCase());
  }
  // Imported accounts: mail where neither from nor to/cc is a known user address.
  // The user's imported address dominates that orphan pool.
  let foundNew = true;
  while (foundNew) {
    foundNew = false;
    const fromCounts = new Map<string, number>();
    const toCounts = new Map<string, number>();
    for (const email of emails) {
      const from = email.from.toLowerCase();
      const allRecipients = [...email.to, ...email.cc].map((e) => e.toLowerCase());
      if (userEmailSet.has(from) || allRecipients.some((r) => userEmailSet.has(r))) continue;
      fromCounts.set(from, (fromCounts.get(from) || 0) + 1);
      for (const r of allRecipients) toCounts.set(r, (toCounts.get(r) || 0) + 1);
    }
    const candidates = [...fromCounts.entries()]
      .filter(([addr]) => (toCounts.get(addr) || 0) >= 5)
      .sort((a, b) => b[1] - a[1]);
    if (candidates.length > 0) {
      const [topAddr, topCount] = candidates[0];
      const secondCount = candidates.length > 1 ? candidates[1][1] : 0;
      if (topCount >= 20 && (secondCount === 0 || topCount >= secondCount * 3)) {
        userEmailSet.add(topAddr);
        foundNew = true;
        log.info('Detected imported account', {
          from: topCount,
          to: toCounts.get(topAddr) || 0,
          next: secondCount,
        });
      }
    }
  }
  log.info('userEmailSet computed', { count: userEmailSet.size });
  return userEmailSet;
}

function plainBody(email: ParsedEmail): string | null {
  let body = email.bodyText;
  if (!body && email.bodyHtml) body = stripHtml(email.bodyHtml);
  if (body && body.length > 10000) body = body.substring(0, 10000) + '...';
  return body;
}

function groupByContact(
  emails: ParsedEmail[],
  userEmail: string,
  userEmailSet: Set<string>,
  accountEmail: string
): Map<string, ContactAccumulator> {
  const contactMap = new Map<string, ContactAccumulator>();
  for (const email of emails) {
    const isFromMe = email.isSent || userEmailSet.has(email.from.toLowerCase());
    const contactEmails = isFromMe
      ? [...email.to, ...email.cc].filter((e) => !userEmailSet.has(e.toLowerCase()))
      : [email.from];
    const body = plainBody(email);
    for (const contactEmail of contactEmails) {
      const key = contactEmail.toLowerCase();
      let contact = contactMap.get(key);
      if (contact === undefined) {
        contact = {
          email: key,
          name: isFromMe ? null : email.fromName,
          sentCount: 0,
          messages: [],
        };
        contactMap.set(key, contact);
      }
      if (isFromMe) contact.sentCount++;
      else if (email.fromName && !contact.name) contact.name = email.fromName;
      contact.messages.push({
        channel: MessageChannel.EMAIL,
        from: email.from,
        to: isFromMe ? contactEmail : userEmail,
        timestamp: email.date,
        message: email.subject + (body ? '\n\n' + body : ''),
        ...(email.gmailId !== undefined && {
          externalId: gmailExternalId(accountEmail, email.gmailId),
        }),
      });
    }
  }
  return contactMap;
}

/** Contacts the user has written to: stored EMAIL records plus this set's sent mail. */
async function writtenToContacts(
  contactMap: Map<string, ContactAccumulator>,
  userId: string
): Promise<Set<string>> {
  const batchContactEmails = Array.from(contactMap.keys());
  const sentToContacts = await prisma.messageRecord.findMany({
    where: {
      channel: MessageChannel.EMAIL,
      to: { in: batchContactEmails },
      person: { userId },
    },
    select: { to: true },
    distinct: ['to'],
  });
  const written = new Set(
    sentToContacts.map((m) => m.to?.toLowerCase()).filter((e): e is string => Boolean(e))
  );
  for (const [email, contact] of contactMap) {
    if (contact.sentCount > 0) written.add(email);
  }
  return written;
}

function toUpsert(contact: ContactAccumulator): ContactToUpsert {
  let firstName = '';
  let lastName = '';
  if (contact.name) {
    const nameParts = contact.name.split(' ');
    firstName = nameParts[0] || '';
    lastName = nameParts.slice(1).join(' ') || '';
  }
  return {
    identifier: contact.email,
    identifierType: 'email' as const,
    firstName,
    lastName,
    email: contact.email,
    emailAddresses: [contact.email],
    messages: contact.messages,
  };
}

/**
 * Transform Gmail messages into contacts the user has written to. `accountEmail`
 * is the connected address the messages came from (it scopes their dedup key).
 */
export async function toContactsToUpsert(params: {
  emails: ParsedEmail[];
  userEmail: string;
  userId: string;
  accountEmail: string;
  classification?: MailboxClassification;
}): Promise<ContactToUpsert[]> {
  const { emails, userEmail, userId, accountEmail, classification } = params;
  const userEmailSet = classification?.userEmailSet ?? detectUserEmails(emails, userEmail);
  const contactMap = groupByContact(emails, userEmail, userEmailSet, accountEmail);
  if (contactMap.size === 0) return [];
  const valid = classification?.validContacts ?? (await writtenToContacts(contactMap, userId));
  const contacts = [...contactMap.values()].filter((c) => valid.has(c.email));
  log.info('Filtered contacts (user has sent to them)', { count: contacts.length });
  return contacts.map(toUpsert);
}
