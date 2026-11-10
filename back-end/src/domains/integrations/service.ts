/* eslint-disable max-lines -- barrel re-exports + Gmail/Claude Code logic; already split into 5 sub-services */
/**
 * Integrations domain service — business logic, no req/res.
 */

import { type Prisma, IntegrationType, IntegrationStatus, mergeJson } from './types';
import { createLogger } from '../../providers/logger';
import { sendSms } from '../../providers/smsQueue';
import {
  getAdminPhone,
  isAnthropicApiKeyConfigured,
  isEmailProviderSlug,
  isGptApiKeyConfigured,
  isOpenRouterApiKeyConfigured,
} from './config';
import {
  fetchClaudeCodeAccessToken,
  fetchPoolToken,
  markPoolTokenRateLimited,
  markUserTokenRateLimited,
  verifyCredentialEnvelopeDecryptable,
} from '../../providers/claudeCredentials';
import {
  classifyReportedLogin,
  fetchComputeTokenForUser,
  getCerebrasApiKeyCooldown,
  heartbeatComputeTokenLineage,
  isAnthropicApiKeyOnCooldown,
  isGptApiKeyOnCooldown,
  markAnthropicApiKeyOnCooldown,
  markCerebrasApiKeyOnCooldown,
  markGptApiKeyOnCooldown,
  releaseComputeTokenLineage,
} from '../../providers/computeCredentials';
import {
  getFoundryDeploymentCooldowns,
  markFoundryDeploymentCooldown,
  markFoundryDeploymentServed,
} from '../../providers/foundryDeploymentCooldown';
import {
  fetchGptCodeAccessToken,
  fetchGptPoolToken,
  markGptPoolTokenRateLimited,
  markGptUserTokenRateLimited,
} from '../../providers/gptCredentials';
import { getValidAccessToken, gmailMailboxAccess } from '../../services/integrations/gmailSync';
import { fetchGmailMessagesSince } from '../../services/integrations/gmailParser';
import { fetchPrimitiveMessagesSince } from '../../providers/primitive';
import { findReadableInboxes } from '../../providers/authOptionsStore';
import { archiveJson } from '../../providers/traceArchive';
import {
  clearConnectionNeedsReconnectFromIntegrationRecovery,
  resolveAccountIdForCredentialRecovery,
  isIntegrationAuthFailureReason,
} from '../../providers/integrationConnectionSync';
import * as repo from './repo';
import {
  redactLanternIntegration,
  updateLanternIntegration,
  deleteLanternIntegration,
  LanternCredentialError,
} from './service.lantern';
import { settleLinkedInSync } from './service.linkedinSync';
export { LanternCredentialError } from './service.lantern';

const log = createLogger('Integrations');
type GmailSendCredential = NonNullable<Awaited<ReturnType<typeof repo.findGmailCredentialForSend>>>;

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
  LinkedInArchiveWithoutConnectionsError,
  processContactsUpload,
  processEmailZipUpload,
  processIMessageUpload,
  processWhatsAppConnect,
  processWhatsAppUpload,
  processTelegramConnect,
  processTelegramUpload,
  processCookiesUpload,
  processLocalStorageUpload,
  processIndexedDBUpload,
  ingestIndexedDBUploadJson,
  decryptCompressedToUtf8,
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
  IndexedDBUploadPayloadInvalidError,
  IndexedDBUploadPayloadTooLargeError,
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

/**
 * Overlay each email integration's connected addresses from its credential rows.
 *
 * `config.connectedEmails` is a denormalized copy; the credential table is the
 * source of truth. Any writer that replaced `config` wholesale (an OAuth start,
 * a sync) silently dropped that copy and the UI's account chips vanished for a
 * still-connected account. Deriving here means the response cannot disagree
 * with reality, and a config that already lost the field self-heals on read.
 */
function withDerivedConnectedEmails<
  T extends { name: string; config: unknown; emailCredentials: Array<{ email: string | null }> },
>(integrations: T[]): T[] {
  return integrations.map((integration) => {
    if (!isEmailProviderSlug(integration.name)) return integration;

    const derived = integration.emailCredentials
      .map((c) => c.email)
      .filter((e): e is string => e !== null && e !== '');
    const base =
      typeof integration.config === 'object' &&
      integration.config !== null &&
      !Array.isArray(integration.config)
        ? (integration.config as Record<string, unknown>)
        : {};

    // Keep the previously-recorded primary when that account is still
    // connected, so the address the user has been seeing does not change
    // underneath them; otherwise fall back to the oldest credential (the
    // include is ordered, so this is stable across requests).
    const configuredPrimary = typeof base.connectedEmail === 'string' ? base.connectedEmail : null;
    const primary =
      configuredPrimary !== null && derived.includes(configuredPrimary)
        ? configuredPrimary
        : (derived[0] ?? null);

    return {
      ...integration,
      config: { ...base, connectedEmail: primary, connectedEmails: derived },
    };
  });
}

export async function getIntegrations(userId: string) {
  const queryStart = Date.now();
  const hasCachedDomains = repo.isAuthDomainsCached(userId);

  log.info('Fetching integrations', { userId, domainsCached: hasCachedDomains });

  const integrations = (
    await settleLinkedInSync(
      userId,
      withDerivedConnectedEmails(await repo.findIntegrationsByUser(userId))
    )
  ).map(redactLanternIntegration);
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
  if (name === 'lantern_people')
    throw new LanternCredentialError(400, 'USE_LANTERN_CREDENTIAL_UPLOAD');
  return repo.upsertIntegration({ userId, name, type, config: config ?? {} });
}

export async function updateIntegration(
  userId: string,
  name: string,
  updates: { status?: string; isActive?: boolean; config?: Record<string, unknown> }
) {
  if (name === 'lantern_people') return updateLanternIntegration(userId, updates);
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
  if (name === 'lantern_people') return deleteLanternIntegration(userId);
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
  const { gmailCredentials, primitiveInboxEmails: mintedInboxEmails } =
    await findReadableInboxes(userId);
  if (gmailCredentials.length === 0 && mintedInboxEmails.length === 0) {
    const integrations = await repo.findGmailIntegrationsWithCredentials(userId);
    if (integrations.length === 0) throw new GmailNotConnectedError();
    throw new GmailCredentialsNotFoundError();
  }

  const sourceCount = gmailCredentials.length + mintedInboxEmails.length;
  const perAccountLimit = Math.max(1, Math.ceil(limit / sourceCount));
  const emailArrays = await Promise.all(
    gmailCredentials.map(async (credential) => {
      try {
        const accessToken = await getValidAccessToken(credential);
        if (accessToken === null || accessToken === undefined || accessToken === '') {
          log.warn('Failed to get access token', {
            credentialId: credential.id,
          });
          return [];
        }
        // Share the mailbox's quota budget with any sync running on it.
        const emails = await fetchGmailMessagesSince(
          gmailMailboxAccess(credential, accessToken),
          since,
          perAccountLimit
        );
        return emails.map((email) => ({
          ...email,
          credentialId: credential.id,
          credentialEmail: credential.email,
        }));
      } catch {
        log.warn('Failed to fetch from Gmail', {
          credentialId: credential.id,
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
    accounts: gmailCredentials.length,
    mintedInboxes: mintedInboxEmails.length,
    since: since.toISOString(),
    userId,
  });
  return emails;
}

export async function sendEmail(
  userId: string,
  params: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    fromEmail: string;
    agentId?: string;
  }
) {
  const { refreshGmailToken, buildRawEmail } = await import('./oauthService');
  const credential = await requireGmailCredentialForSend(userId, params.fromEmail);
  const accessToken = await usableGmailAccessToken(userId, credential, refreshGmailToken);
  const senderEmail = senderEmailForCredential(credential);
  const rawMessage = buildRawEmail({
    from: senderEmail,
    to: params.to,
    cc: params.cc,
    subject: params.subject,
    body: params.body,
  });
  const requestBody = { raw: rawMessage };
  const archiveRootId = params.agentId ?? userId;
  const archiveContext = {
    user_id: userId,
    agent_id: params.agentId ?? null,
    from_email: senderEmail,
    to: params.to,
    cc: params.cc ?? null,
    subject: params.subject,
  };
  const gmailResult = await postGmailMessage(accessToken, requestBody);

  if (!gmailResult.ok) {
    await archiveEmailBoundary(archiveRootId, {
      provider: 'gmail',
      request: {
        method: 'POST',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        body: requestBody,
      },
      response: gmailResult.data,
      status_code: gmailResult.status,
      success: false,
      context: archiveContext,
    });
    log.error('Send email failed', { status: gmailResult.status });
    if (gmailResult.status === 401) throw new GmailAuthFailedError();
    throw new Error(`Gmail API error: ${gmailResult.status}`);
  }

  const result = gmailResult.data as { id: string; threadId: string };
  await archiveEmailBoundary(archiveRootId, {
    provider: 'gmail',
    request: {
      method: 'POST',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      body: requestBody,
    },
    response: result,
    status_code: gmailResult.status,
    success: true,
    context: {
      ...archiveContext,
      message_id: result.id,
      thread_id: result.threadId,
    },
  });
  log.info('Email sent', { userId });
  return result;
}
/* c8 ignore stop */

async function requireGmailCredentialForSend(
  userId: string,
  fromEmail: string
): Promise<GmailSendCredential> {
  const credential = await repo.findGmailCredentialForSend(userId, fromEmail);
  if (credential?.accessToken !== null && credential?.accessToken !== undefined) return credential;
  const creds = await repo.findAvailableGmailEmails(userId);
  const available = creds
    .map((c) => c.email)
    .filter((email): email is string => email !== null && email !== undefined && email !== '');
  throw new GmailAccountNotFoundError(fromEmail, available);
}

async function usableGmailAccessToken(
  userId: string,
  credential: GmailSendCredential,
  refreshGmailToken: (params: { id: string; refreshToken: string | null }) => Promise<string | null>
): Promise<string> {
  if (
    credential.expiresAt === null ||
    credential.expiresAt === undefined ||
    new Date(credential.expiresAt) > new Date()
  ) {
    return credential.accessToken!;
  }

  log.info('Access token expired, refreshing', { userId });
  const newToken = await refreshGmailToken({
    id: credential.id,
    refreshToken: credential.refreshToken,
  });
  if (newToken === null || newToken === undefined || newToken === '') {
    throw new GmailTokenExpiredError();
  }
  return newToken;
}

function senderEmailForCredential(credential: GmailSendCredential): string {
  const integrationConfig =
    (credential.integration?.config as Record<string, unknown> | null) ?? {};
  const senderEmail = credential.email ?? (integrationConfig.connectedEmail as string | undefined);
  if (senderEmail === undefined || senderEmail === null || senderEmail === '') {
    throw new Error('Unable to determine sender email address');
  }
  return senderEmail;
}

async function postGmailMessage(
  accessToken: string,
  requestBody: { raw: string }
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  return {
    ok: response.ok,
    status: response.status,
    data: (await response.json()) as Record<string, unknown>,
  };
}

async function archiveEmailBoundary(rootAgentId: string, value: unknown): Promise<void> {
  try {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    await archiveJson({
      rootAgentId,
      objectPath: `provider/email/gmail/${suffix}.json.gz.enc`,
      value,
    });
  } catch {
    log.warn('Email provider archive failed', {
      rootAgentId,
    });
  }
}

export async function disconnectGmailAccount(userId: string, email: string) {
  const credential = await repo.findGmailCredentialForDisconnect(userId, email);
  if (credential === null || credential === undefined) {
    const availableRows = await repo.findAvailableGmailEmails(userId);
    const available = availableRows
      .map((row) => row.email)
      .filter((value): value is string => value !== null && value !== undefined && value !== '');
    throw new GmailAccountNotFoundError(email, available);
  }

  await repo.deleteEmailCredential(credential.id);
  const remainingRows = await repo.findConnectedEmailCredentials(userId, credential.provider);
  const connectedEmails = remainingRows
    .map((row) => row.email)
    .filter((value): value is string => value !== null && value !== undefined && value !== '');

  await repo.updateIntegration(credential.integrationId, {
    status:
      connectedEmails.length > 0 ? IntegrationStatus.CONNECTED : IntegrationStatus.NOT_CONNECTED,
    isActive: connectedEmails.length > 0,
    config: mergeJson(credential.integration.config ?? null, {
      connectedEmail: connectedEmails[0] ?? null,
      connectedEmails,
    }),
  });

  return { disconnectedEmail: email, connectedEmails };
}

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

export class CredentialEnvelopeError extends Error {}

/**
 * Effective pool eligibility for a compute credential the account just synced.
 *
 * Precedence:
 *   1. explicit per-integration override (`Integration.poolingEnabledOverride`)
 *   2. account policy (`User.poolTokensByDefault`) — can only RAISE eligibility
 *   3. whatever the row already had (fresh rows: not pooled)
 *
 * The account policy never lowers an already-pooled token, so the mac-app
 * pushing a rotated token on every refresh can't silently drain the pool. An
 * operator who deliberately excludes (or includes) one token sets the override,
 * which wins over the account policy in both directions.
 */
export function resolveSyncedPoolingEnabled(params: {
  accountDefault: boolean;
  existing?: { poolingEnabled: boolean; poolingEnabledOverride: boolean | null } | null;
}): boolean {
  const override = params.existing?.poolingEnabledOverride;
  if (override !== null && override !== undefined) return override;
  if (params.accountDefault) return true;
  return params.existing?.poolingEnabled ?? false;
}

async function resolvePoolingForCredentialSync(
  userId: string,
  name: string,
  accountId?: string | null
): Promise<boolean> {
  const [accountDefault, existing] = await Promise.all([
    repo.findUserPoolTokensByDefault(userId),
    repo.findIntegrationPoolingState(userId, name, accountId),
  ]);
  return resolveSyncedPoolingEnabled({ accountDefault, existing });
}

export async function uploadClaudeCodeCredentials(userId: string, encryptedCredentials: string) {
  const check = verifyCredentialEnvelopeDecryptable(encryptedCredentials);
  if (!check.ok) {
    log.error('Rejecting undecryptable Claude Code credentials', { userId, reason: check.reason });
    throw new CredentialEnvelopeError(check.reason);
  }
  const recoveredAccountId = await resolveAccountIdForCredentialRecovery(
    userId,
    'claude_code',
    encryptedCredentials
  );
  const poolingEnabled = await resolvePoolingForCredentialSync(
    userId,
    'claude_code',
    recoveredAccountId
  );
  log.info('Storing Claude Code credentials', {
    userId,
    poolingEnabled,
    accountId: recoveredAccountId,
  });
  await repo.upsertIntegrationRaw({
    userId,
    name: 'claude_code',
    accountId: recoveredAccountId,
    type: IntegrationType.TOOL_SETUP,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    poolingEnabled,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: { encryptedCredentials },
    updateExtra: { failureReason: null, rateLimitedUntil: null, lastUsedAt: null },
  });
  await clearConnectionNeedsReconnectFromIntegrationRecovery({
    userId,
    integrationName: 'claude_code',
    accountId: recoveredAccountId,
  });
  log.info('Claude Code credentials stored', { userId, poolingEnabled });
}

export async function uploadGptCodeCredentials(userId: string, encryptedCredentials: string) {
  const check = verifyCredentialEnvelopeDecryptable(encryptedCredentials);
  if (!check.ok) {
    log.error('Rejecting undecryptable GPT Code credentials', { userId, reason: check.reason });
    throw new CredentialEnvelopeError(check.reason);
  }
  const recoveredAccountId = await resolveAccountIdForCredentialRecovery(
    userId,
    'gpt_code',
    encryptedCredentials
  );
  const poolingEnabled = await resolvePoolingForCredentialSync(
    userId,
    'gpt_code',
    recoveredAccountId
  );
  log.info('Storing GPT Code credentials', {
    userId,
    poolingEnabled,
    accountId: recoveredAccountId,
  });
  await repo.upsertIntegrationRaw({
    userId,
    name: 'gpt_code',
    accountId: recoveredAccountId,
    type: IntegrationType.TOOL_SETUP,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    poolingEnabled,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: { encryptedCredentials },
    updateExtra: { failureReason: null, rateLimitedUntil: null, lastUsedAt: null },
  });
  await clearConnectionNeedsReconnectFromIntegrationRecovery({
    userId,
    integrationName: 'gpt_code',
    accountId: recoveredAccountId,
  });
  log.info('GPT Code credentials stored', { userId, poolingEnabled });
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
  excludePoolTokenIds?: string[],
  lineage?: {
    lineageKey?: string;
    agentId?: string;
    rootAgentId?: string;
    fastCacheAffinityKey?: string;
    tokenType?: 'claude' | 'gpt';
  }
) {
  const result = await fetchComputeTokenForUser(userId, {
    forcePool,
    excludePoolTokenIds,
    lineageKey: lineage?.lineageKey,
    agentId: lineage?.agentId,
    rootAgentId: lineage?.rootAgentId,
    fastCacheAffinityKey: lineage?.fastCacheAffinityKey,
    tokenType: lineage?.tokenType,
  });
  if (result === null || result === undefined) throw new NoTokensAvailableError();
  return {
    type: result.type,
    accessToken: result.accessToken,
    accountId: result.accountId,
    source: result.source,
    poolTokenId: result.poolTokenId,
    integrationId: result.integrationId,
    lineageKey: result.lineageKey,
    fastCacheAffinityKey: lineage?.fastCacheAffinityKey,
  };
}

export { heartbeatComputeTokenLineage, releaseComputeTokenLineage };
export { parseSubscriptionUsageReport } from '../../providers/computeSubscriptionUsage';

/**
 * A worker's auth-failure report disables a login only when it names that login
 * and the stored credential is still the live token the worker held
 * (classifyReportedLogin). Null lets the report through; otherwise the reply
 * for a report that changes nothing.
 */
async function unrevokedLoginReply(
  type: 'claude' | 'gpt',
  source: 'user' | 'pool',
  params: {
    poolTokenId?: string;
    integrationId?: string;
    failureReason?: string;
    credential?: string;
  }
) {
  if (!isIntegrationAuthFailureReason(params.failureReason)) return null;
  const integrationId = source === 'pool' ? params.poolTokenId : params.integrationId;
  const rejection = await classifyReportedLogin(type, integrationId, params.credential);
  if (rejection === 'revoked') return null;
  log.warn(`Login rejection report not applied: ${rejection}`, {
    type,
    source,
    integrationId: integrationId ?? null,
    failureReason: params.failureReason,
  });
  return { ok: true, source, disabled: false, rejection };
}

export async function markTokenRateLimited(
  source: string,
  params: {
    poolTokenId?: string;
    userId?: string;
    rateLimitedUntil?: string;
    failureReason?: string;
    integrationId?: string;
    credential?: string;
  }
) {
  if (source === 'pool') {
    if (params.poolTokenId === undefined || params.poolTokenId === '') {
      throw new Error('Missing poolTokenId for source=pool');
    }
    const unrevoked = await unrevokedLoginReply('claude', source, params);
    if (unrevoked !== null) return unrevoked;
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
    const unrevoked = await unrevokedLoginReply('claude', source, params);
    if (unrevoked !== null) return unrevoked;
    await markUserTokenRateLimited(params.userId, {
      rateLimitedUntil: params.rateLimitedUntil,
      failureReason: params.failureReason,
      integrationId: params.integrationId,
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
    credentialId?: string;
    integrationId?: string;
    credential?: string;
    model?: string;
    region?: string;
    deployment?: string;
    retryAfterSeconds?: number;
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
  if (type === 'cerebras') {
    await markCerebrasApiKeyOnCooldown(
      params.credentialId ?? '',
      params.model ?? '',
      params.rateLimitedUntil ?? ''
    );
    return { ok: true, type, rateLimitedUntil: params.rateLimitedUntil };
  }
  if (type === 'gpt_api_key') {
    await markGptApiKeyOnCooldown(params.failureReason ?? 'out_of_credits');
    return { ok: true, type, rateLimitedUntil: null };
  }
  if (type === 'foundry') {
    // One shared cooldown per Azure (region, deployment) for every worker.
    const state = await markFoundryDeploymentCooldown(
      params.region ?? '',
      params.deployment ?? '',
      params.retryAfterSeconds
    );
    return { ok: true, type, ...state };
  }
  throw new Error(
    'Invalid type. Must be "claude", "gpt", "anthropic", "cerebras", "foundry", or "gpt_api_key".'
  );
}

export { getFoundryDeploymentCooldowns, markFoundryDeploymentServed };

export async function getGptApiKeyCooldown() {
  return {
    configured: isGptApiKeyConfigured(),
    onCooldown: await isGptApiKeyOnCooldown(),
  };
}

export { getCerebrasApiKeyCooldown };

/** Read the running backend's shared ANTHROPIC_API_KEY availability.
 *  Consumers must require both configured=true and onCooldown=false before
 *  selecting the funded-default tier; no secret material leaves the process.
 *  `openrouterConfigured` lets Claude Code preflight proceed when the shared
 *  Anthropic org is on cooldown but OpenRouter can back the sandbox. */
export async function getAnthropicApiKeyCooldown() {
  return {
    configured: isAnthropicApiKeyConfigured(),
    onCooldown: await isAnthropicApiKeyOnCooldown(),
    openrouterConfigured: isOpenRouterApiKeyConfigured(),
  };
}

export async function markGptTokenRateLimited(
  source: string,
  params: {
    poolTokenId?: string;
    userId?: string;
    rateLimitedUntil?: string;
    failureReason?: string;
    integrationId?: string;
    credential?: string;
  }
) {
  if (source === 'pool') {
    if (params.poolTokenId === undefined || params.poolTokenId === '') {
      throw new Error('Missing poolTokenId for source=pool');
    }
    const unrevoked = await unrevokedLoginReply('gpt', source, params);
    if (unrevoked !== null) return unrevoked;
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
    const unrevoked = await unrevokedLoginReply('gpt', source, params);
    if (unrevoked !== null) return unrevoked;
    await markGptUserTokenRateLimited(params.userId, {
      rateLimitedUntil: params.rateLimitedUntil,
      failureReason: params.failureReason,
      integrationId: params.integrationId,
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
