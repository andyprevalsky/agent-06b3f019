/**
 * Branded transactional-email delivery through a connected Gmail account.
 *
 * This provider is intentionally independent of the integrations domain so
 * product domains can send service-owned email without crossing domain
 * boundaries or depending on the acting user's connected inbox.
 */

import { EmailProvider } from '@prisma/client';

import { getValidAccessToken } from '../services/integrations/gmailSync';
import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('TransactionalEmail');

export interface TransactionalEmailInput {
  ownerUserId: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  body: string;
}

export class TransactionalEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionalEmailError';
  }
}

/** A failure known to have happened before Gmail accepted the message. */
export class TransactionalEmailDefinitiveError extends TransactionalEmailError {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionalEmailDefinitiveError';
  }
}

export interface TransactionalEmailDependencies {
  getAccessToken: typeof getValidAccessToken;
  fetch: typeof fetch;
  requestTimeoutMs: number;
}

const TRANSACTIONAL_EMAIL_DEPENDENCIES: TransactionalEmailDependencies = {
  getAccessToken: getValidAccessToken,
  fetch: (input, init) => fetch(input, init),
  requestTimeoutMs: 15_000,
};

function assertSafeHeader(name: string, value: string): void {
  if (value === '' || /[\r\n]/.test(value)) {
    throw new TransactionalEmailDefinitiveError(`Invalid ${name} email header`);
  }
}

/** Build the RFC 5322 message accepted by Gmail's messages.send endpoint. */
export function buildTransactionalRawEmail(input: Omit<TransactionalEmailInput, 'ownerUserId'>) {
  assertSafeHeader('from', input.from);
  assertSafeHeader('fromName', input.fromName);
  assertSafeHeader('to', input.to);
  assertSafeHeader('subject', input.subject);

  const raw = [
    `From: ${input.fromName} <${input.from}>`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    input.body,
  ].join('\r\n');

  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Send one transactional email from a service-owned connected Gmail inbox. */
export async function sendTransactionalEmail(
  input: TransactionalEmailInput,
  dependencies: TransactionalEmailDependencies = TRANSACTIONAL_EMAIL_DEPENDENCIES
): Promise<{ id: string }> {
  const credential = await prisma.emailIntegrationCredential.findFirst({
    where: {
      userId: input.ownerUserId,
      provider: EmailProvider.GMAIL,
      email: input.from,
    },
    select: {
      id: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
    },
  });
  if (credential === null) {
    throw new TransactionalEmailDefinitiveError(`Sender ${input.from} is not connected`);
  }

  const accessToken = await dependencies.getAccessToken(credential);
  if (accessToken === null) {
    throw new TransactionalEmailDefinitiveError(`Sender ${input.from} needs to reconnect Gmail`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), dependencies.requestTimeoutMs);
  try {
    const response = await dependencies.fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: buildTransactionalRawEmail(input) }),
        signal: controller.signal,
      }
    );
    let data: { id?: unknown; error?: { message?: unknown } };
    try {
      data = (await response.json()) as typeof data;
    } catch (error) {
      if (!response.ok) {
        throw new TransactionalEmailDefinitiveError(`Gmail HTTP ${response.status}`);
      }
      throw error;
    }
    if (!response.ok) {
      const providerMessage =
        typeof data.error?.message === 'string'
          ? data.error.message
          : `Gmail HTTP ${response.status}`;
      log.error('Transactional email send failed', {
        sender: input.from,
        recipientDomain: input.to.split('@').at(-1) ?? 'unknown',
        status: response.status,
        error: providerMessage,
      });
      throw new TransactionalEmailDefinitiveError(providerMessage);
    }
    if (typeof data.id !== 'string') {
      throw new TransactionalEmailError('Gmail accepted the request without a message id');
    }

    log.info('Transactional email accepted', {
      messageId: data.id,
      sender: input.from,
      recipientDomain: input.to.split('@').at(-1) ?? 'unknown',
    });
    return { id: data.id };
  } catch (error) {
    if (error instanceof TransactionalEmailDefinitiveError) throw error;
    if (controller.signal.aborted) {
      throw new TransactionalEmailError('Gmail request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
