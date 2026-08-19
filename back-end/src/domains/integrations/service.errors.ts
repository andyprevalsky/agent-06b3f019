/**
 * Integrations domain — error classes.
 * Split from service.ts for max-lines compliance.
 */

import { IntegrationType } from './types';

export class InvalidIntegrationTypeError extends Error {
  constructor(_type: string) {
    super(`Invalid integration type. Must be one of: ${Object.values(IntegrationType).join(', ')}`);
    this.name = 'InvalidIntegrationTypeError';
  }
}

export class IntegrationNotFoundError extends Error {
  constructor(_name: string) {
    super('Integration not found');
    this.name = 'IntegrationNotFoundError';
  }
}

export class GmailNotConnectedError extends Error {
  constructor() {
    super('Gmail not connected');
    this.name = 'GmailNotConnectedError';
  }
}

export class GmailCredentialsNotFoundError extends Error {
  constructor() {
    super('Gmail credentials not found');
    this.name = 'GmailCredentialsNotFoundError';
  }
}

export class GmailAccountNotFoundError extends Error {
  available: string[];
  fromEmail: string;
  constructor(fromEmail: string, available: string[]) {
    super(
      available.length > 0
        ? `No connected Gmail account found for '${fromEmail}'. Available accounts: ${available.join(', ')}`
        : 'Connect your Gmail in order to allow Rose to send emails on your behalf. To connect your Gmail click on the hamburger icon > Integrations > Connect Gmail'
    );
    this.name = 'GmailAccountNotFoundError';
    this.available = available;
    this.fromEmail = fromEmail;
  }
}

export class GmailTokenExpiredError extends Error {
  constructor() {
    super(
      'Your Gmail connection has expired. Please reconnect your Gmail by clicking on the hamburger icon > Integrations > Connect Gmail'
    );
    this.name = 'GmailTokenExpiredError';
  }
}

export class GmailAuthFailedError extends Error {
  constructor() {
    super(
      'Your Gmail connection has expired. Please reconnect your Gmail by clicking on the hamburger icon > Integrations > Connect Gmail'
    );
    this.name = 'GmailAuthFailedError';
  }
}

export class ClaudeCodeCredentialsNotFoundError extends Error {
  constructor() {
    super('Claude Code credentials not found. Sync credentials from the Mac app.');
    this.name = 'ClaudeCodeCredentialsNotFoundError';
  }
}

export class NoTokensAvailableError extends Error {
  constructor() {
    super('NO_TOKENS_AVAILABLE');
    this.name = 'NoTokensAvailableError';
  }
}

// IndexedDBUploadPayload*Error live in types.ts so repo can throw them without
// a repo → service layer-deps violation. Re-exported here for service callers.
export { IndexedDBUploadPayloadInvalidError, IndexedDBUploadPayloadTooLargeError } from './types';
