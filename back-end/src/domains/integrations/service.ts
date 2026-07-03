/* eslint-disable max-lines -- barrel re-exports + Gmail/Claude Code logic; already split into 5 sub-services */
/**
 * Integrations domain service — business logic, no req/res.
 */

import { type Prisma, IntegrationType, IntegrationStatus } from './types';
import { createLogger } from '../../providers/logger';
import { sendSms } from '../../providers/smsQueue';
import { getAdminPhone } from './config';
import {
  fetchClaudeCodeAccessToken,
  fetchPoolToken,
  markPoolTokenRateLimited,
  markUserTokenRateLimited,
} from '../../providers/claudeCredentials';
import {
  fetchComputeTokenForUser,
  isAnthropicApiKeyOnCooldown,
  markAnthropicApiKeyOnCooldown,
} from '../../providers/computeCredentials';
import {
  fetchGptCodeAccessToken,
  fetchGptPoolToken,
  markGptPoolTokenRateLimited,
  markGptUserTokenRateLimited,
} from '../../providers/gptCredentials';
import { getValidAccessToken } from '../../services/integrations/gmailSync';
import { fetchGmailMessagesSince } from '../../services/integrations/gmailParser';
import { fetchPrimitiveMessagesSince } from '../../providers/primitive';
import * as repo from './repo';

const log = createLogger('Integrations');

// Re-export sub-services for routes to consume from a single import
export {
  normalizeProvider,
  startEmailOAuth,
  sendOAuthResult,
  refreshGmailToken,
  buildRawEmail,
} from './oauthService';

export { handleOAuthCallback } from './oauthService.callback';

export {
  processGenericUpload,
  processLinkedInUpload,
  processContactsUpload,
  processEmailZipUpload,
  processIMessageUpload,
  processWhatsAppUpload,
  processTelegramConnect,
  processTelegramUpload,
  processCookiesUpload,
  processLocalStorageUpload,
  processIndexedDBUpload,
  processFingerprintUpload,
  processPermissionsUpload,
  processCacheStorageUpload,
  processPasswordsUpload,
  processPasskeysUpload,
  processApplePasswordsUpload,
  processDocumentsUpload,
  decryptPayload,
  decryptCompressedPayload,
} from './uploadService';

export type {
  ContactWithMessages,
  WhatsAppContactWithMessages,
  TelegramContactWithMessages,
} from './uploadService';

// Re-export error classes
export {
  InvalidIntegrationTypeError,
  IntegrationNotFoundError,
  GmailNotConnectedError,
  GmailCredentialsNotFoundError,
  GmailAccountNotFoundError,
  GmailTokenExpiredError,
  GmailAuthFailedError,
  ClaudeCodeCredentialsNotFoundError,
  NoTokensAvailableError,
} from './service.errors';

import {
  InvalidIntegrationTypeError,
  IntegrationNotFoundError,
  GmailNotConnectedError,
  GmailCredentialsNotFoundError,
  GmailAccountNotFoundError,
  GmailTokenExpiredError,
  GmailAuthFailedError,
  // ClaudeCodeCredentialsNotFoundError, // TEMP: unused while onboarding gate is disabled
  NoTokensAvailableError,
} from './service.errors';

// ---------------------------------------------------------------------------
// Integration CRUD
// ---------------------------------------------------------------------------

export async function getIntegrations(userId: string) {
  const queryStart = Date.now();
  const hasCachedDomains = repo.isAuthDomainsCached(userId);

  log.info('Fetching integrations', { userId, domainsCached: hasCachedDomains });

  const integrations = await repo.findIntegrationsByUser(userId);
  log.info('Integrations query done', { durationMs: Date.now() - queryStart });

  const authenticatedDomains = await repo.getAuthenticatedDomains(userId);
  if (!hasCachedDomains) {
    log.info('Domains query done', {
      durationMs: Date.now() - queryStart,
      domainCount: authenticatedDomains.length,
    });
  }

  return { integrations, count: integrations.length, authenticatedDomains };
}

export async function createIntegration(
  userId: string,
  name: string,
  type: IntegrationType,
  config?: Prisma.InputJsonValue
) {
  if (!Object.values(IntegrationType).includes(type)) {
    throw new InvalidIntegrationTypeError(type);
  }
  return repo.upsertIntegration({ userId, name, type, config: config ?? {} });
}

export async function updateIntegration(
  userId: string,
  name: string,
  updates: { status?: string; isActive?: boolean; config?: Record<string, unknown> }
) {
  const existing = await repo.findIntegrationByUserAndName(userId, name);
  if (existing === null || existing === undefined) {
    throw new IntegrationNotFoundError(name);
  }
  const updateData: Record<string, unknown> = {};
  if (updates.status !== undefined) {
    if (!Object.values(IntegrationStatus).includes(updates.status as IntegrationStatus)) {
      throw new Error(`Invalid integration status: ${updates.status}`);
    }
    updateData.status = updates.status;
  }
  if (updates.isActive !== undefined) updateData.isActive = updates.isActive;
  if (updates.config !== undefined) updateData.config = updates.config;
  return repo.updateIntegration(existing.id, updateData);
}

export async function deleteIntegration(userId: string, name: string) {
  const integration = await repo.findIntegrationByUserAndName(userId, name);
  if (integration === null || integration === undefined) {
    throw new IntegrationNotFoundError(name);
  }
  await repo.deleteIntegration(integration.id);
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

/* c8 ignore start -- fetchEmailsSince and sendEmail require real Gmail OAuth credentials and gmailSync/gmailParser services */
export async function fetchEmailsSince(userId: string, since: Date, limit: number) {
  const integrations = await repo.findGmailIntegrationsWithCredentials(userId);
  const allCredentials = integrations
    .flatMap((i) => i.emailCredentials)
    .filter(
      (c) =>
        c.refreshToken !== null &&
        c.refreshToken !== undefined &&
        c.refreshToken !== '' &&
        c.accessToken !== null &&
        c.accessToken !== undefined &&
        c.accessToken !== ''
    );
  const mintedInboxEmails = await repo.findMintedAccountEmails(userId);
  if (allCredentials.length === 0 && mintedInboxEmails.length === 0) {
    if (integrations.length === 0) throw new GmailNotConnectedError();
    throw new GmailCredentialsNotFoundError();
  }

  const sourceCount = allCredentials.length + mintedInboxEmails.length;
  const perAccountLimit = Math.max(1, Math.ceil(limit / sourceCount));
  const emailArrays = await Promise.all(
    allCredentials.map(async (credential) => {
      try {
        const accessToken = await getValidAccessToken(credential);
        if (accessToken === null || accessToken === undefined || accessToken === '') {
          log.warn('Failed to get access token', {
            credentialId: credential.id,
            email: credential.email,
          });
          return [];
        }
        const emails = await fetchGmailMessagesSince(accessToken, since, perAccountLimit);
        return emails.map((email) => ({
          ...email,
          credentialId: credential.id,
          credentialEmail: credential.email,
        }));
      } catch (err: unknown) {
        log.warn('Failed to fetch from Gmail', {
          email: credential.email,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    })
  );
  const mintedEmails = await fetchPrimitiveMessagesSince({
    inboxEmails: mintedInboxEmails,
    since,
    limit: perAccountLimit * Math.max(1, mintedInboxEmails.length),
  });

  const emails = emailArrays
    .flat()
    .concat(mintedEmails)
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, limit);
  log.info('Fetched emails', {
    count: emails.length,
    accounts: allCredentials.length,
    mintedInboxes: mintedInboxEmails.length,
    since: since.toISOString(),
    userId,
  });
  return emails;
}

export async function sendEmail(
  userId: string,
  params: { to: string; subject: string; body: string; cc?: string; fromEmail: string }
) {
  const { refreshGmailToken, buildRawEmail } = await import('./oauthService');
  const credential = await repo.findGmailCredentialForSend(userId, params.fromEmail);

  if (
    credential === null ||
    credential === undefined ||
    credential.accessToken === null ||
    credential.accessToken === undefined
  ) {
    const creds = await repo.findAvailableGmailEmails(userId);
    const available = creds
      .map((c) => c.email)
      .filter((e): e is string => e !== null && e !== undefined && e !== '');
    throw new GmailAccountNotFoundError(params.fromEmail, available);
  }

  let accessToken = credential.accessToken;
  const isExpired =
    credential.expiresAt !== null &&
    credential.expiresAt !== undefined &&
    new Date(credential.expiresAt) <= new Date();

  if (isExpired) {
    log.info('Access token expired, refreshing', { userId });
    const newToken = await refreshGmailToken({
      id: credential.id,
      refreshToken: credential.refreshToken,
    });
    if (newToken === null || newToken === undefined || newToken === '')
      throw new GmailTokenExpiredError();
    accessToken = newToken;
  }

  const integrationConfig =
    (credential.integration?.config as Record<string, unknown> | null) ?? {};
  const senderEmail = credential.email ?? (integrationConfig.connectedEmail as string | undefined);
  if (senderEmail === undefined || senderEmail === null || senderEmail === '') {
    throw new Error('Unable to determine sender email address');
  }

  const rawMessage = buildRawEmail({
    from: senderEmail,
    to: params.to,
    cc: params.cc,
    subject: params.subject,
    body: params.body,
  });
  const gmailResponse = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rawMessage }),
    }
  );

  if (!gmailResponse.ok) {
    const errorData = (await gmailResponse.json()) as Record<string, unknown>;
    log.error('Send email failed', { error: JSON.stringify(errorData) });
    if (gmailResponse.status === 401) throw new GmailAuthFailedError();
    const errMsg = (errorData.error as Record<string, unknown> | undefined)?.message;
    throw new Error(typeof errMsg === 'string' ? errMsg : 'Unknown Gmail API error');
  }

  const result = (await gmailResponse.json()) as { id: string; threadId: string };
  log.info('Email sent', { userId, messageId: result.id });
  return result;
}
/* c8 ignore stop */

export async function getAvailableGmailEmails(userId: string) {
  const creds = await repo.findAvailableGmailEmails(userId);
  return creds.map((c) => c.email).filter((e): e is string => e !== null && e !== undefined);
}

// ---------------------------------------------------------------------------
// Password request / Claude Code / Token management
// ---------------------------------------------------------------------------

export async function sendPasswordRequest(userId: string, request: string) {
  const user = await repo.findUserById(userId);
  const userName = user?.name ?? user?.phone ?? userId;
  const message = `\uD83D\uDD11 Password integration request from ${userName}: ${request.trim()}`;
  const result = await sendSms(getAdminPhone(), message);
  if (!result.success) {
    log.error('Failed to send feature request SMS', { error: result.error });
    throw new Error('Failed to send request');
  }
  log.info('Password integration request sent', {
    userId,
    userName,
    request: request.substring(0, 50),
  });
}

export async function uploadClaudeCodeCredentials(userId: string, encryptedCredentials: string) {
  log.info('Storing Claude Code credentials', { userId });
  await repo.upsertIntegrationRaw({
    userId,
    name: 'claude_code',
    type: IntegrationType.TOOL_SETUP,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: { encryptedCredentials },
    updateExtra: { failureReason: null, rateLimitedUntil: null, lastUsedAt: null },
  });
  log.info('Claude Code credentials stored', { userId });
}

export async function uploadGptCodeCredentials(userId: string, encryptedCredentials: string) {
  log.info('Storing GPT Code credentials', { userId });
  await repo.upsertIntegrationRaw({
    userId,
    name: 'gpt_code',
    type: IntegrationType.TOOL_SETUP,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: { encryptedCredentials },
    updateExtra: { failureReason: null },
  });
  log.info('GPT Code credentials stored', { userId });
}

export async function getClaudeCodeToken(
  userId: string,
  forcePool: boolean,
  excludePoolTokenIds?: string[]
) {
  if (!forcePool) {
    const userToken = await fetchClaudeCodeAccessToken(userId);
    if (userToken !== null && userToken !== undefined && userToken !== '') {
      return { accessToken: userToken, source: 'user' as const };
    }
  }
  // TEMP: onboarding gate disabled — pool is open to all authenticated users (incl. anon)
  // const user = await repo.findUserById(userId);
  // if (user?.onboardingCompletedAt === null || user?.onboardingCompletedAt === undefined) {
  //   throw new ClaudeCodeCredentialsNotFoundError();
  // }
  const poolResult = await fetchPoolToken(excludePoolTokenIds);
  if (poolResult === null || poolResult === undefined) throw new NoTokensAvailableError();
  return {
    accessToken: poolResult.accessToken,
    source: 'pool' as const,
    poolTokenId: poolResult.poolTokenId,
  };
}

export async function getGptCodeToken(
  userId: string,
  forcePool: boolean,
  excludePoolTokenIds?: string[]
) {
  if (!forcePool) {
    const userToken = await fetchGptCodeAccessToken(userId);
    if (
      userToken?.accessToken !== undefined &&
      userToken.accessToken !== null &&
      userToken.accessToken !== ''
    ) {
      return {
        accessToken: userToken.accessToken,
        accountId: userToken.accountId,
        source: 'user' as const,
      };
    }
  }
  const poolResult = await fetchGptPoolToken(excludePoolTokenIds);
  if (poolResult === null || poolResult === undefined) throw new NoTokensAvailableError();
  return {
    accessToken: poolResult.accessToken,
    accountId: poolResult.accountId,
    source: 'pool' as const,
    poolTokenId: poolResult.poolTokenId,
  };
}

export async function getComputeCodeToken(
  userId: string,
  forcePool: boolean,
  excludePoolTokenIds?: string[]
) {
  const result = await fetchComputeTokenForUser(userId, { forcePool, excludePoolTokenIds });
  if (result === null || result === undefined) throw new NoTokensAvailableError();
  return {
    type: result.type,
    accessToken: result.accessToken,
    accountId: result.accountId,
    source: result.source,
    poolTokenId: result.poolTokenId,
  };
}

export async function markTokenRateLimited(
  source: string,
  params: {
    poolTokenId?: string;
    userId?: string;
    rateLimitedUntil?: string;
    failureReason?: string;
  }
) {
  if (source === 'pool') {
    if (params.poolTokenId === undefined || params.poolTokenId === '') {
      throw new Error('Missing poolTokenId for source=pool');
    }
    await markPoolTokenRateLimited(params.poolTokenId, {
      rateLimitedUntil: params.rateLimitedUntil,
      failureReason: params.failureReason,
    });
    return {
      ok: true,
      source,
      poolTokenId: params.poolTokenId,
      rateLimitedUntil: params.rateLimitedUntil ?? null,
      failureReason: params.failureReason ?? null,
    };
  }
  if (source === 'user') {
    if (params.userId === undefined || params.userId === '') {
      throw new Error('Missing userId for source=user');
    }
    await markUserTokenRateLimited(params.userId, {
      rateLimitedUntil: params.rateLimitedUntil,
      failureReason: params.failureReason,
    });
    return {
      ok: true,
      source,
      userId: params.userId,
      rateLimitedUntil: params.rateLimitedUntil ?? null,
    };
  }
  throw new Error('Invalid source. Must be "pool" or "user".');
}

export async function markComputeTokenRateLimited(
  type: string,
  source: string,
  params: {
    poolTokenId?: string;
    userId?: string;
    rateLimitedUntil?: string;
    failureReason?: string;
  }
) {
  if (type === 'claude') {
    return markTokenRateLimited(source, params);
  }
  if (type === 'gpt') {
    return markGptTokenRateLimited(source, params);
  }
  if (type === 'anthropic') {
    // The shared ANTHROPIC_API_KEY funded default. Not a per-user/pool token —
    // a single global credential — so source/poolTokenId are ignored and we
    // back off the shared DB cooldown (same row the backend chat path reads).
    await markAnthropicApiKeyOnCooldown(params.failureReason ?? 'rate_limit');
    return { ok: true, type, rateLimitedUntil: null };
  }
  throw new Error('Invalid type. Must be "claude", "gpt", or "anthropic".');
}

/** Read the shared ANTHROPIC_API_KEY cooldown — lets the agents Rose client
 *  skip the funded-default tier when it's backed off, without DB access. */
export async function getAnthropicApiKeyCooldown() {
  return { onCooldown: await isAnthropicApiKeyOnCooldown() };
}

export async function markGptTokenRateLimited(
  source: string,
  params: {
    poolTokenId?: string;
    userId?: string;
    rateLimitedUntil?: string;
    failureReason?: string;
  }
) {
  if (source === 'pool') {
    if (params.poolTokenId === undefined || params.poolTokenId === '') {
      throw new Error('Missing poolTokenId for source=pool');
    }
    await markGptPoolTokenRateLimited(params.poolTokenId, {
      rateLimitedUntil: params.rateLimitedUntil,
      failureReason: params.failureReason,
    });
    return {
      ok: true,
      source,
      poolTokenId: params.poolTokenId,
      rateLimitedUntil: params.rateLimitedUntil ?? null,
      failureReason: params.failureReason ?? null,
    };
  }
  if (source === 'user') {
    if (params.userId === undefined || params.userId === '') {
      throw new Error('Missing userId for source=user');
    }
    await markGptUserTokenRateLimited(params.userId, {
      rateLimitedUntil: params.rateLimitedUntil,
      failureReason: params.failureReason,
    });
    return {
      ok: true,
      source,
      userId: params.userId,
      rateLimitedUntil: params.rateLimitedUntil ?? null,
    };
  }
  throw new Error('Invalid source. Must be "pool" or "user".');
}

export async function markPoolTokenAsRateLimited(
  poolTokenId: string,
  rateLimitedUntil?: string,
  failureReason?: string
) {
  await markPoolTokenRateLimited(poolTokenId, { rateLimitedUntil, failureReason });
  return {
    ok: true,
    poolTokenId,
    rateLimitedUntil: rateLimitedUntil ?? null,
    failureReason: failureReason ?? null,
  };
}

export async function markGptPoolTokenAsRateLimited(
  poolTokenId: string,
  rateLimitedUntil?: string,
  failureReason?: string
) {
  await markGptPoolTokenRateLimited(poolTokenId, { rateLimitedUntil, failureReason });
  return {
    ok: true,
    poolTokenId,
    rateLimitedUntil: rateLimitedUntil ?? null,
    failureReason: failureReason ?? null,
  };
}
