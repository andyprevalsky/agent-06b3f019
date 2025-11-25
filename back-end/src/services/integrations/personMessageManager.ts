import { MessageChannel } from '@prisma/client';
import NodeCache from 'node-cache';
import { prisma } from '../../lib/prisma';

const PERSON_CHUNK_SIZE = 50;
const MESSAGE_BATCH_SIZE = 10000;

export interface ContactToUpsert {
  // Primary identifier (phone number or email)
  identifier: string;
  identifierType: 'phone' | 'email';

  // Person data
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  email?: string;
  emailAddresses?: string[];

  // Messages (timestamps already normalized to Date)
  messages: Array<{
    channel: MessageChannel;
    from: string;
    to: string;
    timestamp: Date;
    message: string;
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
    .map(m => m.timestamp)
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
  jobCache: NodeCache
): Promise<{ contacts: number; messages: number }> {
  const totalMessages = contacts.reduce((sum, c) => sum + c.messages.length, 0);
  console.log(`[Job ${jobId}] Processing ${totalMessages} messages from ${contacts.length} contacts for user ${userId}`);

  let messagesProcessed = 0;
  let contactsProcessed = 0;

  // Process contacts in chunks
  for (let i = 0; i < contacts.length; i += PERSON_CHUNK_SIZE) {
    const chunk = contacts.slice(i, i + PERSON_CHUNK_SIZE);

    // Upsert persons for this chunk
    await upsertContactsChunk(userId, chunk);

    // Build lookup map for person IDs
    const phoneContacts = chunk.filter(c => c.identifierType === 'phone');
    const emailContacts = chunk.filter(c => c.identifierType === 'email');

    const phoneIdentifiers = phoneContacts.map(c => c.identifier);
    const emailIdentifiers = emailContacts.map(c => c.identifier);

    // Fetch persons by phone
    const personsByPhone = phoneIdentifiers.length > 0
      ? await prisma.person.findMany({
          where: { userId, phoneNumber: { in: phoneIdentifiers } },
          select: { id: true, phoneNumber: true },
        })
      : [];

    // Fetch persons by email
    const personsByEmail = emailIdentifiers.length > 0
      ? await prisma.person.findMany({
          where: {
            userId,
            OR: [
              { email: { in: emailIdentifiers } },
              { emailAddresses: { array_contains: emailIdentifiers } },
            ],
          },
          select: { id: true, email: true, emailAddresses: true },
        })
      : [];

    // Build identifier -> personId map
    const personMap = new Map<string, string>();

    personsByPhone.forEach(p => {
      if (p.phoneNumber) personMap.set(p.phoneNumber, p.id);
    });

    personsByEmail.forEach(p => {
      if (p.email) personMap.set(p.email, p.id);
      if (p.emailAddresses && Array.isArray(p.emailAddresses)) {
        (p.emailAddresses as string[]).forEach(email => {
          if (email && !personMap.has(email)) {
            personMap.set(email, p.id);
          }
        });
      }
    });

    // Process each contact's messages
    for (const contact of chunk) {
      try {
        const personId = personMap.get(contact.identifier);

        if (!personId) {
          console.warn(`[Job ${jobId}] ⚠️ Person not found for contact ${contact.identifier}, skipping messages`);
          continue;
        }

        if (!contact.messages?.length) {
          console.warn(`[Job ${jobId}] ⚠️ No messages for contact ${contact.identifier}, skipping`);
          continue;
        }

        // Insert messages in batches
        for (let batchIndex = 0; batchIndex < contact.messages.length; batchIndex += MESSAGE_BATCH_SIZE) {
          const batch = contact.messages.slice(batchIndex, batchIndex + MESSAGE_BATCH_SIZE);

          await prisma.messageRecord.createMany({
            data: batch.map(msg => ({
              personId,
              channel: msg.channel,
              from: msg.from,
              to: msg.to,
              timestamp: msg.timestamp,
              message: msg.message,
            })),
            skipDuplicates: true,
          });
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

        // Update job progress
        const currentState = jobCache.get<any>(jobId);
        if (currentState) {
          jobCache.set(jobId, {
            ...currentState,
            messagesProcessed,
            contactsCreated: contactsProcessed,
            progress: Math.round((messagesProcessed / totalMessages) * 100),
          });
        }

        console.log(`[Job ${jobId}] Processed contact ${contact.identifier}: ${contact.messages.length} messages (${messagesProcessed}/${totalMessages} total)`);
      } catch (error) {
        console.error(`[Job ${jobId}] Error processing contact ${contact.identifier}:`, error);
      }
    }
  }

  console.log(`[Job ${jobId}] ✅ Stored ${messagesProcessed} messages from ${contactsProcessed} contacts`);
  return { contacts: contactsProcessed, messages: messagesProcessed };
}

/**
 * Upsert a chunk of contacts as Person records.
 * Handles phone/email cross-linking and deduplication.
 */
async function upsertContactsChunk(userId: string, chunk: ContactToUpsert[]) {
  if (!chunk.length) return;

  // Separate contacts by type
  const phoneContacts = chunk.filter(c => c.identifierType === 'phone');
  const emailContacts = chunk.filter(c => c.identifierType === 'email');

  // Collect all identifiers to check
  const phonesToCheck = phoneContacts.map(c => c.identifier);
  const allEmailsToCheck = new Set<string>();

  // Add emails from email contacts
  emailContacts.forEach(c => {
    if (c.email) allEmailsToCheck.add(c.email);
    if (c.identifier) allEmailsToCheck.add(c.identifier);
    c.emailAddresses?.forEach(e => allEmailsToCheck.add(e));
  });

  // Add emails from phone contacts (for cross-linking)
  phoneContacts.forEach(c => {
    if (c.email) allEmailsToCheck.add(c.email);
    c.emailAddresses?.forEach(e => allEmailsToCheck.add(e));
  });

  const emailsArray = Array.from(allEmailsToCheck);

  // Query existing persons by phone
  const existingByPhone = phonesToCheck.length > 0
    ? await prisma.person.findMany({
        where: { userId, phoneNumber: { in: phonesToCheck } },
        select: { id: true, phoneNumber: true, email: true, emailAddresses: true },
      })
    : [];

  // Query existing persons by email
  const existingByEmail = emailsArray.length > 0
    ? await prisma.person.findMany({
        where: {
          userId,
          OR: [{ email: { in: emailsArray } }],
        },
        select: { id: true, phoneNumber: true, email: true, emailAddresses: true },
      })
    : [];

  // Build comprehensive lookup maps
  const personMap = new Map<string, (typeof existingByPhone)[0]>();

  // Index by phone number
  existingByPhone.forEach(p => {
    if (p.phoneNumber) personMap.set(p.phoneNumber, p);
  });

  // Index by email (primary and all emailAddresses)
  existingByEmail.forEach(p => {
    if (p.email) personMap.set(p.email, p);
    if (p.emailAddresses && Array.isArray(p.emailAddresses)) {
      (p.emailAddresses as string[]).forEach(email => {
        if (email && !personMap.has(email)) {
          personMap.set(email, p);
        }
      });
    }
  });

  // Build operations with cross-type deduplication
  const createPayload: ReturnType<typeof buildPersonCreateData>[] = [];
  const updateOperations: Array<{ id: string; data: Record<string, unknown> }> = [];
  const processedPersonIds = new Set<string>();

  for (const contact of chunk) {
    let existing: (typeof existingByPhone)[0] | undefined;

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
      updateOperations.map(operation =>
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
    phoneNumber: isEmail ? null : contact.identifier,
    email: primaryEmail,
    emailAddresses,
    firstName: contact.firstName || '',
    lastName: contact.lastName || '',
    ...(contact.company && { company: contact.company }),
    ...(contact.title && { title: contact.title }),
  };
}

function buildPersonUpdateData(contact: ContactToUpsert) {
  const emailAddresses = contact.emailAddresses?.filter(Boolean) ?? [];
  const isEmail = contact.identifierType === 'email';

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

