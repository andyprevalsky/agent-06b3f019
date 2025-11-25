import { MessageChannel } from '@prisma/client';
import NodeCache from 'node-cache';
import { prisma } from '../../lib/prisma';
import AdmZip from 'adm-zip';

const PERSON_CHUNK_SIZE = 50;
const MESSAGE_BATCH_SIZE = 5000;

export interface ParsedEmail {
  from: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string;
  date: Date;
  messageId: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
}

interface EmailContact {
  email: string;
  name: string | null;
  sentCount: number;
  receivedCount: number;
  messages: Array<{
    from: string;
    to: string;
    subject: string;
    date: Date;
    body: string | null;
    isFromMe: boolean;
  }>;
}

/**
 * Parse an EML file content into structured email data
 */
export function parseEmlContent(emlContent: string): ParsedEmail | null {
  try {
    // Normalize line endings to \n
    const normalizedContent = emlContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Handle line folding (lines starting with space/tab are continuations)
    const unfoldedContent = normalizedContent.replace(/\n[ \t]+/g, ' ');
    
    // Split headers and body
    const headerBodySplit = unfoldedContent.indexOf('\n\n');
    if (headerBodySplit === -1) return null;
    
    const headerSection = unfoldedContent.substring(0, headerBodySplit);
    const bodySection = unfoldedContent.substring(headerBodySplit + 2);
    
    const headers = parseHeaders(headerSection);
    
    const from = extractEmailAddress(headers['from'] || '');
    if (!from) return null;
    
    const fromName = extractName(headers['from'] || '');
    const to = extractEmailAddresses(headers['to'] || '');
    const cc = extractEmailAddresses(headers['cc'] || '');
    const subject = decodeHeader(headers['subject'] || '(No Subject)');
    const dateStr = headers['date'] || '';
    const messageId = headers['message-id'] || null;
    
    // Parse date
    let date: Date;
    try {
      date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        date = new Date();
      }
    } catch {
      date = new Date();
    }
    
    // Parse body
    const contentType = headers['content-type'] || 'text/plain';
    let bodyText: string | null = null;
    let bodyHtml: string | null = null;
    
    if (contentType.includes('multipart')) {
      const boundary = extractBoundary(contentType);
      if (boundary) {
        const parts = parseMultipart(bodySection, boundary);
        bodyText = parts.text;
        bodyHtml = parts.html;
      }
    } else if (contentType.includes('text/html')) {
      bodyHtml = decodeBody(bodySection, headers['content-transfer-encoding']);
    } else {
      bodyText = decodeBody(bodySection, headers['content-transfer-encoding']);
    }
    
    return {
      from,
      fromName,
      to,
      cc,
      subject,
      date,
      messageId,
      bodyText,
      bodyHtml,
    };
  } catch (error) {
    console.error('Error parsing EML:', error);
    return null;
  }
}

function parseHeaders(headerSection: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = headerSection.split('\n');
  
  let currentKey = '';
  let currentValue = '';
  
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      // Save previous header
      if (currentKey) {
        headers[currentKey.toLowerCase()] = currentValue.trim();
      }
      currentKey = line.substring(0, colonIndex);
      currentValue = line.substring(colonIndex + 1);
    } else {
      // Continuation of previous header
      currentValue += ' ' + line.trim();
    }
  }
  
  // Save last header
  if (currentKey) {
    headers[currentKey.toLowerCase()] = currentValue.trim();
  }
  
  return headers;
}

function extractEmailAddress(str: string): string | null {
  // Match email in angle brackets: "Name <email@domain.com>"
  const angleMatch = str.match(/<([^>]+@[^>]+)>/);
  if (angleMatch) return angleMatch[1].toLowerCase();
  
  // Match plain email
  const plainMatch = str.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (plainMatch) return plainMatch[0].toLowerCase();
  
  return null;
}

function extractEmailAddresses(str: string): string[] {
  const emails: string[] = [];
  
  // Split by comma, handling quoted names
  const parts = str.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  
  for (const part of parts) {
    const email = extractEmailAddress(part);
    if (email) emails.push(email);
  }
  
  return emails;
}

function extractName(str: string): string | null {
  // Match name before angle brackets: "Name <email@domain.com>"
  const match = str.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  
  // Match quoted name
  const quotedMatch = str.match(/^"([^"]+)"/);
  if (quotedMatch) return quotedMatch[1].trim();
  
  return null;
}

function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary="?([^";\s]+)"?/i);
  return match ? match[1] : null;
}

function parseMultipart(body: string, boundary: string): { text: string | null; html: string | null } {
  let text: string | null = null;
  let html: string | null = null;
  
  const parts = body.split('--' + boundary);
  
  for (const part of parts) {
    if (part.trim() === '' || part.trim() === '--') continue;
    
    const partHeaderEnd = part.indexOf('\n\n');
    if (partHeaderEnd === -1) continue;
    
    const partHeaders = parseHeaders(part.substring(0, partHeaderEnd));
    const partBody = part.substring(partHeaderEnd + 2);
    const partContentType = partHeaders['content-type'] || 'text/plain';
    const encoding = partHeaders['content-transfer-encoding'];
    
    if (partContentType.includes('text/plain') && !text) {
      text = decodeBody(partBody, encoding);
    } else if (partContentType.includes('text/html') && !html) {
      html = decodeBody(partBody, encoding);
    } else if (partContentType.includes('multipart')) {
      // Nested multipart
      const nestedBoundary = extractBoundary(partContentType);
      if (nestedBoundary) {
        const nested = parseMultipart(partBody, nestedBoundary);
        if (!text && nested.text) text = nested.text;
        if (!html && nested.html) html = nested.html;
      }
    }
  }
  
  return { text, html };
}

function decodeBody(body: string, encoding?: string): string {
  if (!encoding) return body.trim();
  
  const enc = encoding.toLowerCase();
  
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
    } catch {
      return body.trim();
    }
  }
  
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(body);
  }
  
  return body.trim();
}

function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '') // Soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeHeader(str: string): string {
  // Decode RFC 2047 encoded words: =?charset?encoding?text?=
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf-8');
      } else if (encoding.toUpperCase() === 'Q') {
        return decodeQuotedPrintable(text.replace(/_/g, ' '));
      }
    } catch {
      return text;
    }
    return text;
  });
}

/**
 * Extract emails from a ZIP file containing EML files
 */
export function parseEmailZip(zipPath: string): ParsedEmail[] {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const emails: ParsedEmail[] = [];
  
  for (const entry of entries) {
    if (entry.entryName.endsWith('.eml') && !entry.isDirectory) {
      try {
        const content = entry.getData().toString('utf-8');
        const parsed = parseEmlContent(content);
        if (parsed) {
          emails.push(parsed);
        }
      } catch (error) {
        console.error(`Error parsing ${entry.entryName}:`, error);
      }
    }
  }
  
  return emails;
}

/**
 * Import parsed emails into the database
 */
export async function importEmailsToDb(
  userId: string,
  userEmails: string[], // User's email addresses to identify sent vs received
  emails: ParsedEmail[],
  jobId: string,
  jobCache: NodeCache
): Promise<{ contacts: number; messages: number }> {
  console.log(`[Job ${jobId}] Processing ${emails.length} emails for user ${userId}`);
  
  // Normalize user emails
  const userEmailSet = new Set(userEmails.map(e => e.toLowerCase()));
  
  // Group emails by contact
  const contactMap = new Map<string, EmailContact>();
  
  for (const email of emails) {
    const isFromMe = userEmailSet.has(email.from);
    
    // Determine the contact email(s)
    let contactEmails: string[] = [];
    
    if (isFromMe) {
      // User sent this email - contacts are recipients
      contactEmails = [...email.to, ...email.cc].filter(e => !userEmailSet.has(e));
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
  const validContacts = Array.from(contactMap.values()).filter(c => c.sentCount > 0);
  
  console.log(`[Job ${jobId}] Found ${validContacts.length} valid contacts (sent at least one email)`);
  
  // Get or create integration
  const integration = await prisma.integration.upsert({
    where: { userId_name: { userId, name: 'email' } },
    create: {
      userId,
      name: 'email',
      type: 'DATA_SOURCE',
      status: 'SYNCING',
      isActive: true,
    },
    update: {
      status: 'SYNCING',
    },
  });
  
  let contactsProcessed = 0;
  let messagesProcessed = 0;
  const totalMessages = validContacts.reduce((sum, c) => sum + c.messages.length, 0);
  
  // Process contacts in chunks
  for (let i = 0; i < validContacts.length; i += PERSON_CHUNK_SIZE) {
    const chunk = validContacts.slice(i, i + PERSON_CHUNK_SIZE);
    
    // Upsert persons
    for (const contact of chunk) {
      try {
        // Find or create person by email
        let person = await prisma.person.findFirst({
          where: {
            userId,
            OR: [
              { email: contact.email },
              { emailAddresses: { array_contains: [contact.email] } },
            ],
          },
        });
        
        if (!person) {
          // Parse name
          let firstName = '';
          let lastName = '';
          if (contact.name) {
            const nameParts = contact.name.split(' ');
            firstName = nameParts[0] || '';
            lastName = nameParts.slice(1).join(' ') || '';
          }
          
          person = await prisma.person.create({
            data: {
              userId,
              email: contact.email,
              emailAddresses: [contact.email],
              firstName,
              lastName,
            },
          });
        }
        
        // Insert messages in batches
        for (let batchIdx = 0; batchIdx < contact.messages.length; batchIdx += MESSAGE_BATCH_SIZE) {
          const batch = contact.messages.slice(batchIdx, batchIdx + MESSAGE_BATCH_SIZE);
          
          await prisma.messageRecord.createMany({
            data: batch.map(msg => ({
              personId: person!.id,
              channel: MessageChannel.EMAIL,
              from: msg.from,
              to: msg.to,
              timestamp: msg.date,
              message: msg.subject + (msg.body ? '\n\n' + msg.body : ''),
            })),
            skipDuplicates: true,
          });
          
          messagesProcessed += batch.length;
        }
        
        // Update person stats
        await prisma.person.update({
          where: { id: person.id },
          data: {
            messagesExchanged: { increment: contact.messages.length },
          },
        });
        
        contactsProcessed++;
        
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
        
      } catch (error) {
        console.error(`[Job ${jobId}] Error processing contact ${contact.email}:`, error);
      }
    }
  }
  
  // Update integration status
  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      status: 'CONNECTED',
      lastSyncAt: new Date(),
      lastSuccessfulSyncAt: new Date(),
      config: {
        lastUploadedAt: new Date().toISOString(),
        totalEmailsProcessed: emails.length,
        totalContactsFound: validContacts.length,
      },
    },
  });
  
  console.log(`[Job ${jobId}] ✅ Imported ${messagesProcessed} messages from ${contactsProcessed} contacts`);
  
  return { contacts: contactsProcessed, messages: messagesProcessed };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

