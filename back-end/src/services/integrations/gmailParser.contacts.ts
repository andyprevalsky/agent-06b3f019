import { MessageChannel } from '@prisma/client';
import { createLogger } from '../../providers/logger';
import { ContactToUpsert } from './personMessageManager';
import { ParsedEmail, EmailContact, EmailMetadata, stripHtml } from './gmailParser.helpers';

const log = createLogger('GmailParser');

/**
 * From metadata, determine which message IDs involve contacts the user has sent to.
 * Returns the set of needed message IDs for full content fetch.
 */
export function identifyNeededMessageIds(
  metadata: EmailMetadata[],
  userEmail: string
): Set<string> {
  // Build userEmailSet with import detection
  const userEmailSet = new Set<string>([userEmail.toLowerCase()]);
  for (const e of metadata) {
    if (e.isSent) userEmailSet.add(e.from);
  }

  // Detect imported accounts (same dominance logic as transformEmailsToContacts)
  let foundNew = true;
  while (foundNew) {
    foundNew = false;
    const fromCounts = new Map<string, number>();
    const toCounts = new Map<string, number>();
    for (const e of metadata) {
      const allRecipients = [...e.to, ...e.cc];
      if (userEmailSet.has(e.from) || allRecipients.some((r) => userEmailSet.has(r))) continue;
      fromCounts.set(e.from, (fromCounts.get(e.from) || 0) + 1);
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
          from_count: topCount,
          next_count: secondCount,
        });
      }
    }
  }

  // Count sentCount per contact
  const contactSentCount = new Map<string, number>();
  for (const e of metadata) {
    const isFromMe = e.isSent || userEmailSet.has(e.from);
    if (isFromMe) {
      for (const r of [...e.to, ...e.cc]) {
        if (!userEmailSet.has(r)) {
          contactSentCount.set(r, (contactSentCount.get(r) || 0) + 1);
        }
      }
    }
  }

  // Contacts with sentCount > 0
  const validContacts = new Set(
    [...contactSentCount.entries()].filter(([, c]) => c > 0).map(([e]) => e)
  );

  log.info('Contact filter', {
    valid_contact_count: validContacts.size,
    user_email_set: [...userEmailSet],
  });

  // Collect message IDs that involve valid contacts
  const neededIds = new Set<string>();
  for (const e of metadata) {
    const isFromMe = e.isSent || userEmailSet.has(e.from);
    const contactEmails = isFromMe
      ? [...e.to, ...e.cc].filter((addr) => !userEmailSet.has(addr))
      : [e.from];
    if (contactEmails.some((ce) => validContacts.has(ce))) {
      neededIds.add(e.id);
    }
  }

  return neededIds;
}

/**
 * Transform emails into ContactToUpsert format grouped by contact
 */
export function transformEmailsToContacts(
  emails: ParsedEmail[],
  userEmail: string
): ContactToUpsert[] {
  const contactMap = new Map<string, EmailContact>();

  // Build user email set using multiple signals:
  // 1. The connected email address
  // 2. "from" addresses on SENT-labeled emails (Gmail native sent)
  // 3. Imported emails: custom-label-only emails where "from" matches the user's name pattern
  const userEmailSet = new Set<string>([userEmail.toLowerCase()]);

  // Collect from SENT-labeled emails
  for (const email of emails) {
    if (email.isSent) {
      userEmailSet.add(email.from.toLowerCase());
    }
  }

  // Detect imported accounts: if an email is in the mailbox but neither the "from"
  // nor any "to"/"cc" contains a known user email, it was imported from another account.
  // The user's imported address will appear frequently in both "from" (sent) and "to"
  // (received) roles. External contacts may also appear in both roles (e.g. emailed you
  // AND was CC'd), but at much lower frequency.
  let foundNew = true;
  while (foundNew) {
    foundNew = false;
    const fromCounts = new Map<string, number>();
    const toCounts = new Map<string, number>();

    for (const email of emails) {
      const from = email.from.toLowerCase();
      const allRecipients = [...email.to, ...email.cc].map((e) => e.toLowerCase());

      // Skip emails that involve a known user address
      if (userEmailSet.has(from) || allRecipients.some((r) => userEmailSet.has(r))) continue;

      // This email involves no known user address — it's imported
      fromCounts.set(from, (fromCounts.get(from) || 0) + 1);
      for (const r of allRecipients) {
        toCounts.set(r, (toCounts.get(r) || 0) + 1);
      }
    }

    // The user's imported address dominates the orphan email pool.
    // Find the top sender by fromCount, and only accept it if:
    // 1. fromCount >= 20 (minimum volume)
    // 2. It also appears as a recipient (toCount >= 5)
    // 3. It sends at least 3x more than the next non-related candidate
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
          from_count: topCount,
          to_count: toCounts.get(topAddr) || 0,
          next_count: secondCount,
        });
      }
    }
  }

  log.info('transformEmailsToContacts', {
    email_count: emails.length,
    user_email_count: userEmailSet.size,
  });
  const fromMeCount = emails.filter(
    (e) => e.isSent || userEmailSet.has(e.from.toLowerCase())
  ).length;
  log.info('isFromMe total', { count: fromMeCount });

  for (const email of emails) {
    const isFromMe = email.isSent || userEmailSet.has(email.from.toLowerCase());

    // Determine the contact email(s)
    let contactEmails: string[] = [];

    if (isFromMe) {
      // User sent this email - contacts are recipients (exclude user's own addresses)
      contactEmails = [...email.to, ...email.cc].filter((e) => !userEmailSet.has(e.toLowerCase()));
    } else {
      // User received this email - contact is sender
      contactEmails = [email.from];
    }

    // Get plain text body, stripping HTML if needed
    let bodyContent = email.bodyText;
    if (!bodyContent && email.bodyHtml) {
      bodyContent = stripHtml(email.bodyHtml);
    }

    // Truncate body to reasonable length
    if (bodyContent && bodyContent.length > 10000) {
      bodyContent = bodyContent.substring(0, 10000) + '...';
    }

    for (const contactEmail of contactEmails) {
      if (!contactMap.has(contactEmail)) {
        contactMap.set(contactEmail, {
          email: contactEmail,
          name: isFromMe ? null : email.fromName,
          sentCount: 0,
          receivedCount: 0,
          messages: [],
        });
      }

      const contact = contactMap.get(contactEmail)!;

      if (isFromMe) {
        contact.sentCount++;
      } else {
        contact.receivedCount++;
        // Update name if we have one
        if (email.fromName && !contact.name) {
          contact.name = email.fromName;
        }
      }

      contact.messages.push({
        from: email.from,
        to: contactEmail,
        subject: email.subject,
        date: email.date,
        body: bodyContent,
        isFromMe,
      });
    }
  }

  // Filter contacts: user must have SENT at least one email to them
  const validContacts = Array.from(contactMap.values()).filter((c) => c.sentCount > 0);

  // Transform to ContactToUpsert format
  return validContacts.map((contact) => {
    // Parse name into firstName/lastName
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
      messages: contact.messages.map((msg) => ({
        channel: MessageChannel.EMAIL,
        from: msg.from,
        to: msg.to,
        timestamp: msg.date,
        message: msg.subject + (msg.body ? '\n\n' + msg.body : ''),
      })),
    };
  });
}

/**
 * Detect imported email accounts from parsed emails (without modifying userEmailSet).
 * Returns list of email addresses that appear to be imported user accounts.
 */
export function detectImportedAccounts(emails: ParsedEmail[], userEmail: string): string[] {
  const userEmailSet = new Set<string>([userEmail.toLowerCase()]);
  for (const email of emails) {
    if (email.isSent) userEmailSet.add(email.from.toLowerCase());
  }

  const imported: string[] = [];
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
      for (const r of allRecipients) {
        toCounts.set(r, (toCounts.get(r) || 0) + 1);
      }
    }
    const candidates = [...fromCounts.entries()]
      .filter(([addr]) => (toCounts.get(addr) || 0) >= 5)
      .sort((a, b) => b[1] - a[1]);
    if (candidates.length > 0) {
      const [topAddr, topCount] = candidates[0];
      const secondCount = candidates.length > 1 ? candidates[1][1] : 0;
      if (topCount >= 20 && (secondCount === 0 || topCount >= secondCount * 3)) {
        userEmailSet.add(topAddr);
        imported.push(topAddr);
        foundNew = true;
      }
    }
  }
  return imported;
}
