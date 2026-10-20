import { createLogger } from '../../providers/logger';

const log = createLogger('GmailParser');

export interface ParsedEmail {
  /** Gmail's per-mailbox message id (absent on non-Gmail sources). */
  gmailId?: string;
  from: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string;
  date: Date;
  messageId: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  isSent: boolean;
  labels: string[];
}

export interface GmailMessageListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailProfileResponse {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface GmailHistoryResponse {
  history?: Array<{
    id: string;
    messagesAdded?: Array<{ message: { id: string; threadId: string } }>;
    messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
  }>;
  nextPageToken?: string;
  historyId: string;
}

export interface GmailMessageResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string; size?: number };
    parts?: GmailMessagePart[];
    mimeType?: string;
  };
  internalDate?: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePart[];
}

export interface EmailContact {
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

/** Lightweight email metadata (no body content) for contact detection */
export interface EmailMetadata {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  isSent: boolean;
  /** Gmail internalDate in ms since epoch (0 when Google omitted it). */
  internalDate: number;
}

/**
 * Parse a Gmail API message response into our ParsedEmail format
 */
export function parseGmailMessage(msg: GmailMessageResponse): ParsedEmail | null {
  try {
    const headers = msg.payload?.headers || [];

    const getHeader = (name: string): string | null => {
      const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
      return header?.value || null;
    };

    const fromHeader = getHeader('From') || '';
    const from = extractEmailAddress(fromHeader);
    if (!from) return null;

    const fromName = extractName(fromHeader);
    const toHeader = getHeader('To') || '';
    const ccHeader = getHeader('Cc') || '';
    const to = extractEmailAddresses(toHeader);
    const cc = extractEmailAddresses(ccHeader);
    const subject = decodeHeader(getHeader('Subject') || '(No Subject)');
    const messageId = getHeader('Message-ID');

    // Parse date from internalDate (milliseconds since epoch)
    let date: Date;
    if (msg.internalDate) {
      date = new Date(parseInt(msg.internalDate, 10));
    } else {
      const dateHeader = getHeader('Date');
      date = dateHeader ? new Date(dateHeader) : new Date();
    }

    if (isNaN(date.getTime())) {
      date = new Date();
    }

    // Extract body content
    const { text: bodyText, html: bodyHtml } = extractBody(msg.payload);

    const labels = msg.labelIds || [];
    const isSent = labels.includes('SENT');

    return {
      gmailId: msg.id,
      from,
      fromName,
      to,
      cc,
      subject,
      date,
      messageId,
      bodyText,
      bodyHtml,
      isSent,
      labels,
    };
  } catch (error) {
    log.error('Error parsing message', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Extract body text and HTML from Gmail message payload
 */
export function extractBody(payload?: GmailMessageResponse['payload']): {
  text: string | null;
  html: string | null;
} {
  if (!payload) return { text: null, html: null };

  let text: string | null = null;
  let html: string | null = null;

  // Check if body is directly in payload
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === 'text/html') {
      html = decoded;
    } else {
      text = decoded;
    }
  }

  // Check parts recursively
  if (payload.parts) {
    const result = extractBodyFromParts(payload.parts);
    if (!text && result.text) text = result.text;
    if (!html && result.html) html = result.html;
  }

  return { text, html };
}

export function extractBodyFromParts(parts: GmailMessagePart[]): {
  text: string | null;
  html: string | null;
} {
  let text: string | null = null;
  let html: string | null = null;

  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data && !text) {
      text = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body?.data && !html) {
      html = decodeBase64Url(part.body.data);
    } else if (part.parts) {
      // Nested multipart
      const nested = extractBodyFromParts(part.parts);
      if (!text && nested.text) text = nested.text;
      if (!html && nested.html) html = nested.html;
    }
  }

  return { text, html };
}

export function decodeBase64Url(data: string): string {
  // Gmail uses URL-safe base64
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

export function extractEmailAddress(str: string): string | null {
  // Match email in angle brackets: "Name <email@domain.com>"
  const angleMatch = str.match(/<([^>]+@[^>]+)>/);
  if (angleMatch) return angleMatch[1].toLowerCase();

  // Match plain email
  const plainMatch = str.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (plainMatch) return plainMatch[0].toLowerCase();

  return null;
}

export function extractEmailAddresses(str: string): string[] {
  const emails: string[] = [];

  // Split by comma, handling quoted names
  const parts = str.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);

  for (const part of parts) {
    const email = extractEmailAddress(part);
    if (email) emails.push(email);
  }

  return emails;
}

export function extractName(str: string): string | null {
  // Match name before angle brackets: "Name <email@domain.com>"
  const match = str.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();

  // Match quoted name
  const quotedMatch = str.match(/^"([^"]+)"/);
  if (quotedMatch) return quotedMatch[1].trim();

  return null;
}

export function decodeHeader(str: string): string {
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

export function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '') // Soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function stripHtml(html: string): string {
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
