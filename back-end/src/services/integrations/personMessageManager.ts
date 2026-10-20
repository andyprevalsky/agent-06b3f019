import { MessageChannel, type Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { createLogger } from '../../providers/logger';

const log = createLogger('PersonMessageManager');

const PERSON_CHUNK_SIZE = 50;
const MESSAGE_BATCH_SIZE = 10000;

class DisconnectedGoogleCredentialError extends Error {}

/** The account a batch belongs to was removed while its upload was in flight. */
export class MessageAccountRemovedError extends Error {
  constructor() {
    super('The integration account was removed during the upload');
  }
}

/**
 * Attribution for messages synced by ONE provider-side account (a Telegram
 * user id). Rows carry `sourceAccountId`; inserts stop once `integrationId`
 * (that account's Integration row) is deleted.
 */
export interface MessageAccountScope {
  sourceAccountId: string;
  integrationId: string;
}

async function createAccountScopedBatch(
  data: Prisma.MessageRecordCreateManyInput[],
  userId: string,
  scope: MessageAccountScope
): Promise<void> {
  await runTransactionWithRetry(
    async (tx) => {
      // KEY SHARE conflicts only with the account row's DELETE (not with status
      // or config updates), so an account delete waits for this insert and
      // every later batch sees no row and stops.
      const active = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Integration"
        WHERE "id" = ${scope.integrationId} AND "userId" = ${userId}
        FOR KEY SHARE`;
      if (active.length === 0) throw new MessageAccountRemovedError();
      await tx.messageRecord.createMany({ data, skipDuplicates: true });
    },
    { timeout: 30_000 }
  );
}

async function createMessageBatch(
  data: Prisma.MessageRecordCreateManyInput[],
  userId: string,
  googleAccountEmail?: string,
  googleCredentialId?: string,
  accountScope?: MessageAccountScope
): Promise<void> {
  if (accountScope !== undefined) {
    await createAccountScopedBatch(data, userId, accountScope);
    return;
  }
  if (googleAccountEmail === undefined) {
    await prisma.messageRecord.createMany({ data, skipDuplicates: true });
    return;
  }
  if (googleCredentialId === undefined) throw new DisconnectedGoogleCredentialError();

  await runTransactionWithRetry(
    async (tx) => {
      // The matching lock in deleteEmailCredential serializes disconnect with
      // the insert. A stale sync sees no credential after deletion and stops.
      const active = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "EmailIntegrationCredential"
        WHERE "id" = ${googleCredentialId} AND "userId" = ${userId}
          AND "provider" = 'GMAIL'::"EmailProvider"
          AND lower("email") = ${googleAccountEmail.toLowerCase()}
          AND "accessToken" IS NOT NULL
        FOR SHARE`;
      if (active.length === 0) throw new DisconnectedGoogleCredentialError();
      await tx.messageRecord.createMany({ data, skipDuplicates: true });
    },
    { timeout: 30_000 }
  );
}

export interface ContactToUpsert {
  // Primary identifier (phone number, email, or LinkedIn URL)
  identifier: string;
  identifierType: 'phone' | 'email' | 'linkedin_url';

  // Person data
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  email?: string;
  emailAddresses?: string[];
  /** `<provider>:<accountId>` recorded on a Person this contact creates (multi-account syncs). */
  createdBySource?: string;

  // Messages (timestamps already normalized to Date)
  messages: Array<{
    channel: MessageChannel;
    from: string;
    to: string;
    timestamp: Date;
    message: string;
    externalId?: string; // Platform-native message ID for deduplication
  }>;
}

/**
 * Calculate communication frequency based on message timestamps
 */
function calculateCommunicationFrequency(messages: Array<{ timestamp: Date }>): string {
  if (messages.length === 0) return 'never';

  const now = new Date();
  const datesSeen = new Set<string>();
  const sortedMessages = [...messages]
    .map((m) => m.timestamp)
    .sort((a, b) => b.getTime() - a.getTime()); // Newest first

  const dailyCutoff = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  const weeklyCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const monthlyCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const yearlyCutoff = new Date(now.getTime() - 360 * 24 * 60 * 60 * 1000);

  let dailyCount = 0;
  let weeklyCount = 0;
  let monthlyCount = 0;
  let yearlyCount = 0;

  for (const msgDate of sortedMessages) {
    const msgDateString = msgDate.toISOString().slice(0, 10);
    if (datesSeen.has(msgDateString)) continue;
    datesSeen.add(msgDateString);

    if (msgDate >= dailyCutoff) {
      dailyCount++;
      weeklyCount++;
      monthlyCount++;
      yearlyCount++;
      if (dailyCount >= 4) return 'daily';
      continue;
    }

    if (msgDate >= weeklyCutoff) {
      weeklyCount++;
      monthlyCount++;
      yearlyCount++;
      if (weeklyCount >= 4) return 'weekly';
      continue;
    }

    if (msgDate >= monthlyCutoff) {
      monthlyCount++;
      yearlyCount++;
      if (monthlyCount >= 4) return 'monthly';
      continue;
    }

    if (msgDate >= yearlyCutoff) {
      yearlyCount++;
      if (yearlyCount >= 4) return 'yearly';
      continue;
    }
  }
  return 'rarely';
}

/**
 * Upsert persons and their message records with efficient batching and parallelism.
 * This is the shared logic for iMessage, email, and Gmail parsers.
 */
export async function upsertPersonAndMessageRecords(
  userId: string,
  contacts: ContactToUpsert[],
  jobId: string,
  googleAccountEmail?: string,
  googleCredentialId?: string,
  accountScope?: MessageAccountScope
): Promise<{ contacts: number; messages: number }> {
  const totalMessages = contacts.reduce((sum, c) => sum + c.messages.length, 0);
  log.info('Processing messages', {
    jobId,
    totalMessages,
    contacts: contacts.length,
    userId,
  });

  let messagesProcessed = 0;
  let contactsProcessed = 0;

  // Process contacts in chunks
  for (let i = 0; i < contacts.length; i += PERSON_CHUNK_SIZE) {
    const chunk = contacts.slice(i, i + PERSON_CHUNK_SIZE);

    // Upsert persons for this chunk
    await upsertContactsChunk(userId, chunk);

    // Build lookup map for person IDs with a single consolidated query
    const phoneContacts = chunk.filter((c) => c.identifierType === 'phone');
    const emailContacts = chunk.filter((c) => c.identifierType === 'email');
    const linkedinContacts = chunk.filter((c) => c.identifierType === 'linkedin_url');

    const phoneIdentifiers = phoneContacts.map((c) => c.identifier);
    const emailIdentifiers = emailContacts.map((c) => c.identifier);
    const linkedinIdentifiers = linkedinContacts.map((c) => c.identifier);

    // Single query to fetch all persons matching any identifier type
    const orConditions: Array<Record<string, unknown>> = [];
    if (phoneIdentifiers.length > 0) {
      orConditions.push({ phoneNumber: { in: phoneIdentifiers } });
    }
    if (emailIdentifiers.length > 0) {
      orConditions.push({ email: { in: emailIdentifiers } });
      orConditions.push({ emailAddresses: { array_contains: emailIdentifiers } });
    }
    if (linkedinIdentifiers.length > 0) {
      orConditions.push({ linkedinUrl: { in: linkedinIdentifiers } });
    }

    const matchedPersons =
      orConditions.length > 0
        ? await prisma.person.findMany({
            where: { userId, OR: orConditions },
            select: {
              id: true,
              phoneNumber: true,
              email: true,
              emailAddresses: true,
              linkedinUrl: true,
            },
          })
        : [];

    // Build identifier -> personId map
    const personMap = new Map<string, string>();

    matchedPersons.forEach((p) => {
      if (p.phoneNumber) personMap.set(p.phoneNumber, p.id);
      if (p.email) personMap.set(p.email, p.id);
      if (p.emailAddresses && Array.isArray(p.emailAddresses)) {
        (p.emailAddresses as string[]).forEach((email) => {
          if (email && !personMap.has(email)) {
            personMap.set(email, p.id);
          }
        });
      }
      if (p.linkedinUrl) personMap.set(p.linkedinUrl, p.id);
    });

    // Process each contact's messages
    for (const contact of chunk) {
      try {
        const personId = personMap.get(contact.identifier);

        if (!personId) {
          log.warn('Person not found for contact, skipping messages', {
            jobId,
          });
          continue;
        }

        if (!contact.messages?.length) {
          log.warn('No messages for contact, skipping', {
            jobId,
          });
          continue;
        }

        // Insert messages in batches
        for (
          let batchIndex = 0;
          batchIndex < contact.messages.length;
          batchIndex += MESSAGE_BATCH_SIZE
        ) {
          const batch = contact.messages.slice(batchIndex, batchIndex + MESSAGE_BATCH_SIZE);

          await createMessageBatch(
            batch.map((msg) => ({
              personId,
              channel: msg.channel,
              from: msg.from,
              to: msg.to,
              timestamp: msg.timestamp,
              message: msg.message,
              externalId: msg.externalId,
              googleAccountEmail: googleAccountEmail?.toLowerCase() ?? null,
              sourceAccountId: accountScope?.sourceAccountId ?? null,
            })),
            userId,
            googleAccountEmail,
            googleCredentialId,
            accountScope
          );
        }

        // Calculate communication frequency and update person stats
        const frequency = calculateCommunicationFrequency(contact.messages);

        await prisma.person.update({
          where: { id: personId },
          data: {
            messagesExchanged: contact.messages.length,
            communicationFrequency: frequency,
          },
        });

        contactsProcessed++;
        messagesProcessed += contact.messages.length;

        log.info('Processed contact', {
          jobId,
          messagesInContact: contact.messages.length,
          messagesProcessed,
          totalMessages,
        });
      } catch (error) {
        if (
          error instanceof DisconnectedGoogleCredentialError ||
          error instanceof MessageAccountRemovedError
        ) {
          throw error;
        }
        log.error('Error processing contact', {
          jobId,
        });
      }
    }
  }

  log.info('Stored messages', {
    jobId,
    messagesProcessed,
    contactsProcessed,
  });
  return { contacts: contactsProcessed, messages: messagesProcessed };
}

/**
 * Upsert a chunk of contacts as Person records.
 * Handles phone/email cross-linking and deduplication.
 */
async function upsertContactsChunk(userId: string, chunk: ContactToUpsert[]) {
  if (!chunk.length) return;

  // Separate contacts by type
  const phoneContacts = chunk.filter((c) => c.identifierType === 'phone');
  const emailContacts = chunk.filter((c) => c.identifierType === 'email');
  const linkedinContacts = chunk.filter((c) => c.identifierType === 'linkedin_url');

  // Collect all identifiers to check
  const phonesToCheck = phoneContacts.map((c) => c.identifier);
  const linkedinUrlsToCheck = linkedinContacts.map((c) => c.identifier);
  const allEmailsToCheck = new Set<string>();

  // Add emails from email contacts
  emailContacts.forEach((c) => {
    if (c.email) allEmailsToCheck.add(c.email);
    if (c.identifier) allEmailsToCheck.add(c.identifier);
    c.emailAddresses?.forEach((e) => allEmailsToCheck.add(e));
  });

  // Add emails from phone contacts (for cross-linking)
  phoneContacts.forEach((c) => {
    if (c.email) allEmailsToCheck.add(c.email);
    c.emailAddresses?.forEach((e) => allEmailsToCheck.add(e));
  });

  // Add emails from linkedin contacts (for cross-linking)
  linkedinContacts.forEach((c) => {
    if (c.email) allEmailsToCheck.add(c.email);
    c.emailAddresses?.forEach((e) => allEmailsToCheck.add(e));
  });

  const emailsArray = Array.from(allEmailsToCheck);

  // Single consolidated query for existing persons matching any identifier type
  const orConditions: Array<Record<string, unknown>> = [];
  if (phonesToCheck.length > 0) {
    orConditions.push({ phoneNumber: { in: phonesToCheck } });
  }
  if (emailsArray.length > 0) {
    orConditions.push({ email: { in: emailsArray } });
  }
  if (linkedinUrlsToCheck.length > 0) {
    orConditions.push({ linkedinUrl: { in: linkedinUrlsToCheck } });
  }

  const existingPersons =
    orConditions.length > 0
      ? await prisma.person.findMany({
          where: { userId, OR: orConditions },
          select: {
            id: true,
            phoneNumber: true,
            email: true,
            emailAddresses: true,
            linkedinUrl: true,
          },
        })
      : [];

  // Build comprehensive lookup maps
  const personMap = new Map<string, (typeof existingPersons)[0]>();

  existingPersons.forEach((p) => {
    if (p.phoneNumber) personMap.set(p.phoneNumber, p);
    if (p.email) personMap.set(p.email, p);
    if (p.emailAddresses && Array.isArray(p.emailAddresses)) {
      (p.emailAddresses as string[]).forEach((email) => {
        if (email && !personMap.has(email)) {
          personMap.set(email, p);
        }
      });
    }
    if (p.linkedinUrl) personMap.set(p.linkedinUrl, p);
  });

  // Build operations with cross-type deduplication
  const createPayload: ReturnType<typeof buildPersonCreateData>[] = [];
  const updateOperations: Array<{ id: string; data: Record<string, unknown> }> = [];
  const processedPersonIds = new Set<string>();

  for (const contact of chunk) {
    let existing: (typeof existingPersons)[0] | undefined;

    // Try to find existing Person by multiple identifiers
    // 1. Try primary identifier
    existing = personMap.get(contact.identifier);

    // 2. Try primary email
    if (!existing && contact.email) {
      existing = personMap.get(contact.email);
    }

    // 3. Try any of the emailAddresses
    if (!existing && contact.emailAddresses) {
      for (const email of contact.emailAddresses) {
        existing = personMap.get(email);
        if (existing) break;
      }
    }

    if (!existing) {
      createPayload.push(buildPersonCreateData(userId, contact));
    } else {
      // Avoid updating the same Person multiple times in one chunk
      if (!processedPersonIds.has(existing.id)) {
        processedPersonIds.add(existing.id);
        const updateData = buildPersonUpdateData(contact);
        if (Object.keys(updateData).length > 0) {
          updateOperations.push({
            id: existing.id,
            data: updateData,
          });
        }
      }
    }
  }

  if (createPayload.length) {
    await prisma.person.createMany({
      data: createPayload,
      skipDuplicates: true,
    });
  }

  if (updateOperations.length) {
    await prisma.$transaction(
      updateOperations.map((operation) =>
        prisma.person.update({
          where: { id: operation.id },
          data: operation.data,
        })
      )
    );
  }
}

function buildPersonCreateData(userId: string, contact: ContactToUpsert) {
  const emailAddresses = contact.emailAddresses?.filter(Boolean) ?? [];
  const isEmail = contact.identifierType === 'email';
  const isLinkedin = contact.identifierType === 'linkedin_url';

  // Determine primary email using best-email heuristic
  let primaryEmail: string | null = null;
  if (isEmail) {
    primaryEmail = contact.identifier;
  } else if (contact.email) {
    primaryEmail = contact.email;
  } else if (emailAddresses.length > 0) {
    primaryEmail = emailAddresses[0];
  }

  return {
    userId,
    phoneNumber: isEmail || isLinkedin ? null : contact.identifier,
    email: primaryEmail,
    emailAddresses,
    firstName: contact.firstName || '',
    lastName: contact.lastName || '',
    ...(isLinkedin && { linkedinUrl: contact.identifier }),
    ...(contact.company && { company: contact.company }),
    ...(contact.title && { title: contact.title }),
    ...(contact.createdBySource && { createdBySource: contact.createdBySource }),
  };
}

function buildPersonUpdateData(contact: ContactToUpsert) {
  const emailAddresses = contact.emailAddresses?.filter(Boolean) ?? [];
  const isEmail = contact.identifierType === 'email';
  const isLinkedin = contact.identifierType === 'linkedin_url';

  const data: Record<string, unknown> = {};

  if (contact.firstName) {
    data.firstName = contact.firstName;
  }

  if (contact.lastName) {
    data.lastName = contact.lastName;
  }

  if (contact.company) {
    data.company = contact.company;
  }

  if (contact.title) {
    data.title = contact.title;
  }

  if (isLinkedin) {
    data.linkedinUrl = contact.identifier;
  }

  // Update email using same best-email heuristic
  let primaryEmail: string | null = null;
  if (isEmail) {
    primaryEmail = contact.identifier;
  } else if (contact.email) {
    primaryEmail = contact.email;
  } else if (emailAddresses.length > 0) {
    primaryEmail = emailAddresses[0];
  }

  if (primaryEmail) {
    data.email = primaryEmail;
  }
  if (emailAddresses.length > 0) {
    data.emailAddresses = emailAddresses;
  }

  return data;
}
