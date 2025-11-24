import { PrismaClient, MessageChannel } from '@prisma/client';
import NodeCache from 'node-cache';

const prisma = new PrismaClient();

const INVALID_HANDLE_SENTINEL = 'unknown';

const normalizeHandle = (handle?: string | null) => {
  if (!handle) return '';
  const trimmed = handle.trim();
  if (!trimmed || trimmed.toLowerCase() === INVALID_HANDLE_SENTINEL) {
    return '';
  }
  return trimmed;
};

const PERSON_CHUNK_SIZE = 50;
const MESSAGE_BATCH_SIZE = 10000;

export interface ContactWithMessages {
  contact_id: string;
  contact_name: string | null;
  // Contact enrichment data from Contacts DB
  firstName?: string;
  lastName?: string;
  middleName?: string;
  nickname?: string;
  company?: string;
  jobTitle?: string;
  department?: string;
  email?: string;
  emailAddresses?: string[];
  // Messages for this contact
  messages: MessageData[];
}

export interface MessageData {
  id: number;
  text: string;
  date: number;
  is_from_me: boolean;
  contactHandle?: string;
}

function appleTimestampToDate(appleTimestamp: number): Date {
  const APPLE_EPOCH_OFFSET = 978307200;
  const timestampInSeconds = appleTimestamp / 1_000_000_000;
  const unixTimestamp = timestampInSeconds + APPLE_EPOCH_OFFSET;
  return new Date(unixTimestamp * 1000);
}

function calculateCommunicationFrequency(messages: MessageData[]): string {
  if (messages.length === 0) return 'never';

  const now = new Date();
  const datesSeen = new Set<string>();
  const sortedMessages = messages
    .map(m => appleTimestampToDate(m.date))
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

export async function parseIMessageData(
  userId: string,
  contacts: ContactWithMessages[],
  jobId: string,
  jobCache: NodeCache
): Promise<void> {
  let skippedContacts = 0;
  const sanitizedContacts = contacts.reduce<ContactWithMessages[]>((acc, contact) => {
    const contactId = normalizeHandle(contact.contact_id);
    if (!contactId || !contact.messages?.length) {
      skippedContacts++;
      return acc;
    }
    const normalizedMessages = contact.messages.map((message) => ({
      ...message,
      contactHandle: message.contactHandle ?? contactId,
    }));
    acc.push({
      ...contact,
      contact_id: contactId,
      messages: normalizedMessages,
    });
    return acc;
  }, []);

  const totalMessages = sanitizedContacts.reduce((sum, c) => sum + c.messages.length, 0);
  console.log(`[Job ${jobId}] Processing ${totalMessages} iMessage messages from ${sanitizedContacts.length} contacts for user ${userId}`);
  if (skippedContacts > 0) {
    console.log(`[Job ${jobId}] Skipped ${skippedContacts} contacts due to missing handles or messages`);
  }
  
  const integration = await prisma.integration.findUnique({
    where: { userId_name: { userId, name: 'imessage' } },
  });
  
  if (!integration) {
    throw new Error('Integration not found');
  }
  
  let messagesProcessed = 0;
  let contactsCreated = 0;
  
  for (let i = 0; i < sanitizedContacts.length; i += PERSON_CHUNK_SIZE) {
    const chunk = sanitizedContacts.slice(i, i + PERSON_CHUNK_SIZE);
    const contactIds = chunk.map((contact) => contact.contact_id);
    
    await upsertContactsChunk(userId, chunk);
    
    const persons = await prisma.person.findMany({
      where: {
        userId,
        phoneNumber: { in: contactIds },
      },
      select: {
        id: true,
        phoneNumber: true,
      },
    });
    
    const personMap = new Map(persons.map((person) => [person.phoneNumber, person.id]));
    
    for (const contact of chunk) {
      try {
        const contactId = contact.contact_id;
        const personId = personMap.get(contactId);
        
        if (!personId) {
          console.warn(`[Job ${jobId}] ⚠️ Person not found for contact ${contactId}, skipping messages`);
          continue;
        }
        if (!contact.messages?.length) {
          console.warn(`[Job ${jobId}] ⚠️ No messages for contact ${contactId}, skipping`);
          continue;
        }
        
        for (let batchIndex = 0; batchIndex < contact.messages.length; batchIndex += MESSAGE_BATCH_SIZE) {
          const batch = contact.messages.slice(batchIndex, batchIndex + MESSAGE_BATCH_SIZE);
          
          await prisma.messageRecord.createMany({
            data: batch.map((msg) => ({
              personId,
              channel: MessageChannel.IMESSAGE,
              from: msg.is_from_me ? 'me' : (msg.contactHandle || contactId),
              to: msg.is_from_me ? (msg.contactHandle || contactId) : 'me',
              timestamp: appleTimestampToDate(msg.date),
              message: msg.text,
            })),
            skipDuplicates: true,
          });
        }
        
        // Calculate and update communication stats
        const frequency = calculateCommunicationFrequency(contact.messages);

        await prisma.person.update({
          where: { id: personId },
          data: {
            messagesExchanged: contact.messages.length,
            communicationFrequency: frequency,
          }
        });
        
        contactsCreated++;
        messagesProcessed += contact.messages.length;
        
        const currentState = jobCache.get<any>(jobId);
        if (currentState) {
          jobCache.set(jobId, {
            ...currentState,
            messagesProcessed,
            contactsCreated,
            progress: Math.round((messagesProcessed / totalMessages) * 100),
          });
        }
        
        console.log(`[Job ${jobId}] Processed contact ${contactId}: ${contact.messages.length} messages (${messagesProcessed}/${totalMessages} total)`);
      } catch (error) {
        console.error(`[Job ${jobId}] Error processing contact ${contact.contact_id}:`, error);
      }
    }
  }
  
  // Update Integration metadata
  const existingConfig = (integration.config as any) || {};
  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      config: {
        ...existingConfig,
        lastUploadedAt: new Date().toISOString(),
        totalMessagesProcessed: (existingConfig.totalMessagesProcessed || 0) + totalMessages,
        batchesReceived: (existingConfig.batchesReceived || 0) + 1,
      },
    },
  });
  
  console.log(`[Job ${jobId}] ✅ Stored ${messagesProcessed} messages from ${contactsCreated} contacts`);
}

async function upsertContactsChunk(userId: string, chunk: ContactWithMessages[]) {
  const validContacts = chunk.filter((contact) => !!normalizeHandle(contact.contact_id));
  if (!validContacts.length) {
    return;
  }
  
  // Separate contacts by type (email vs phone)
  const emailContacts = validContacts.filter(c => c.contact_id.includes('@'));
  const phoneContacts = validContacts.filter(c => !c.contact_id.includes('@'));
  
  // Collect all identifiers to check
  const phonesToCheck = phoneContacts.map(c => c.contact_id);
  const allEmailsToCheck = new Set<string>();
  
  // Add emails from email contacts
  emailContacts.forEach(c => {
    if (c.email) allEmailsToCheck.add(c.email);
    if (c.contact_id.includes('@')) allEmailsToCheck.add(c.contact_id);
    c.emailAddresses?.forEach(e => allEmailsToCheck.add(e));
  });
  
  // Add emails from phone contacts (for cross-linking)
  phoneContacts.forEach(c => {
    if (c.email) allEmailsToCheck.add(c.email);
    c.emailAddresses?.forEach(e => allEmailsToCheck.add(e));
  });
  
  const emailsArray = Array.from(allEmailsToCheck);
  
  // Query existing persons by phone
  const existingByPhone = phonesToCheck.length > 0 ? await prisma.person.findMany({
    where: { userId, phoneNumber: { in: phonesToCheck } },
    select: { id: true, phoneNumber: true, email: true, emailAddresses: true }
  }) : [];
  
  // Query existing persons by email (checks both primary email and emailAddresses JSON array)
  const existingByEmail = emailsArray.length > 0 ? await prisma.person.findMany({
    where: { 
      userId,
      OR: [
        { email: { in: emailsArray } },
        // Note: This checks if any email in the JSON array matches
        // Prisma doesn't have great JSON array containment, so we'll handle this in-memory
      ]
    },
    select: { id: true, phoneNumber: true, email: true, emailAddresses: true }
  }) : [];
  
  // Build comprehensive lookup maps
  const personMap = new Map<string, typeof existingByPhone[0]>();
  
  // Index by phone number
  existingByPhone.forEach(p => {
    if (p.phoneNumber) personMap.set(p.phoneNumber, p);
  });
  
  // Index by email (primary and all emailAddresses)
  existingByEmail.forEach(p => {
    if (p.email) personMap.set(p.email, p);
    // Parse emailAddresses JSON array and index each email
    if (p.emailAddresses && Array.isArray(p.emailAddresses)) {
      (p.emailAddresses as string[]).forEach(email => {
        if (email && !personMap.has(email)) {
          personMap.set(email, p);
        }
      });
    }
  });
  
  // Build operations with cross-type deduplication
  const createPayload = [];
  const updateOperations: Array<{ id: string; data: Record<string, unknown> }> = [];
  const processedPersonIds = new Set<string>();
  
  for (const contact of validContacts) {
    let existing: typeof existingByPhone[0] | undefined;
    
    // Try to find existing Person by multiple identifiers
    // 1. Try contact_id (could be phone or email)
    existing = personMap.get(contact.contact_id);
    
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
      createPayload.push(buildPersonCreateData(userId, contact.contact_id, contact));
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

function buildPersonCreateData(
  userId: string,
  contactId: string,
  contact: ContactWithMessages
) {
  const firstName = contact.firstName || '';
  const lastName = contact.lastName || '';
  const emailAddresses = contact.emailAddresses?.filter(Boolean) ?? [];
  const isEmail = contactId.includes('@');
  
  // Determine primary email using best-email heuristic
  let primaryEmail: string | null = null;
  if (isEmail) {
    // If they messaged via email, that's the active one
    primaryEmail = contactId;
  } else if (contact.email) {
    // Otherwise use Contacts.app's primary email
    primaryEmail = contact.email;
  } else if (emailAddresses.length > 0) {
    // Fallback to first available email
    primaryEmail = emailAddresses[0];
  }
  
  return {
    userId,
    phoneNumber: isEmail ? null : contactId,
    email: primaryEmail,
    imessageHandle: contactId,
    emailAddresses,
    firstName,
    lastName,
    ...(contact.company && { company: contact.company }),
    ...(contact.jobTitle && { title: contact.jobTitle }),
  };
}

function buildPersonUpdateData(contact: ContactWithMessages) {
  const emailAddresses = contact.emailAddresses?.filter(Boolean) ?? [];
  const isEmail = contact.contact_id.includes('@');
  
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
  
  if (contact.jobTitle) {
    data.title = contact.jobTitle;
  }
  
  // Update email using same best-email heuristic
  let primaryEmail: string | null = null;
  if (isEmail) {
    primaryEmail = contact.contact_id;
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
