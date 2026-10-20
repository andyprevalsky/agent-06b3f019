/**
 * OAuth callback handler — token exchange, credential update, and email sync.
 * Split from oauthService.ts for max-lines compliance.
 */

import {
  IntegrationStatus,
  mergeJson,
  type EmailProvider,
  type OAuthResponse,
  type EmailProviderSlug,
  type TokenExchangeResult,
} from './types';
import { createLogger } from '../../providers/logger';
import { syncGmailIntegrationNow } from '../../services/integrations/gmailSync';
import { startGoogleWorkspaceSync } from '../../services/integrations/googleWorkspaceSync';
import { EMAIL_PROVIDER_CONFIG } from './config';
import { storedOAuthGrant } from './googleOAuthCredential';
import * as repo from './repo';
import { exchangeProviderCode, buildRedirectUri, sendOAuthResult } from './oauthService';
import { resolveSourceConnectGate } from './sourceConnectGate';

const log = createLogger('Integrations');

function maybeSyncGmailAfterOAuth(params: {
  providerKey: EmailProviderSlug;
  accessToken: string;
  userEmail: string | undefined;
  userId: string;
  integrationId: string;
  credentialId: string;
}): void {
  if (
    params.providerKey !== 'gmail' ||
    params.accessToken === '' ||
    params.userEmail === undefined ||
    params.userEmail === null ||
    params.userEmail === ''
  ) {
    return;
  }
  // The cron job's own claimed, per-address sync: progress per address, batches
  // saved as they arrive, a resume cursor and the history cursor. A row the
  // cron already claimed is left to that run.
  void syncGmailIntegrationNow(params.integrationId).catch((error: unknown) => {
    log.error('Error syncing Gmail emails', {
      integrationId: params.integrationId,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
  });
}

/**
 * Google granted every requested scope: release any agent waiting on the
 * connection and start the first Calendar and Drive sync in the background.
 */
async function onCompleteGrant(userId: string, providerKey: EmailProviderSlug): Promise<void> {
  await resolveSourceConnectGate(userId, providerKey);
  if (providerKey === 'gmail') startGoogleWorkspaceSync(userId);
}

/** Handle an already-connected email — refresh tokens and return. */
async function handleExistingEmail(
  userId: string,
  tokenResult: TokenExchangeResult,
  existingCredentialId: string,
  pendingCredentialId: string,
  existingIntegrationId: string,
  existingRefreshToken: string | null,
  existingMetadata: unknown,
  providerKey: EmailProviderSlug,
  email: string,
  expiresAt: Date | null,
  res: OAuthResponse,
  returnUrl: string | null,
  errorUrl: string | null
): Promise<void> {
  log.info('Gmail already connected, refreshing tokens', { credentialId: existingCredentialId });
  await repo.deleteEmailCredential(pendingCredentialId);
  const grant = storedOAuthGrant(providerKey, tokenResult, existingRefreshToken);

  await repo.updateEmailCredential(existingCredentialId, {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt,
    scopes: tokenResult.scopes,
    metadata: mergeJson(existingMetadata ?? null, tokenResult.metadata),
    // This is the reconnect path: re-consent is exactly what clears a
    // needs_reconnect account, so the health state must reset with the tokens.
    state: grant.state,
    lastErrorReason: grant.lastErrorReason,
  });

  await repo.updateIntegrationStatus(existingIntegrationId, IntegrationStatus.CONNECTED, {
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
  });

  sendOAuthResult(res, {
    success: grant.complete,
    message: grant.complete
      ? `${email} was already connected. Tokens refreshed.`
      : 'Google did not grant all requested permissions. Reconnect Google.',
    returnUrl,
    errorUrl,
  });
  if (grant.complete) await onCompleteGrant(userId, providerKey);
}

/** Finalize a new credential: save tokens, update integration, and start email sync. */
async function finalizeNewCredential(
  credential: {
    id: string;
    userId: string;
    integrationId: string;
    refreshToken: string | null;
    metadata: unknown;
  },
  tokenResult: TokenExchangeResult,
  expiresAt: Date | null,
  provider: EmailProvider,
  providerKey: EmailProviderSlug,
  res: OAuthResponse,
  returnUrl: string | null,
  errorUrl: string | null
): Promise<void> {
  const grant = storedOAuthGrant(providerKey, tokenResult, credential.refreshToken);
  await repo.updateEmailCredential(credential.id, {
    email: tokenResult.userEmail,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt,
    scopes: tokenResult.scopes,
    metadata: mergeJson(credential.metadata ?? null, tokenResult.metadata),
    pkceVerifier: null,
    stateToken: null,
    state: grant.state,
    lastErrorReason: grant.lastErrorReason,
  });

  const allCredentials = await repo.findConnectedEmailCredentials(credential.userId, provider);
  const connectedEmails = allCredentials
    .map((c) => c.email)
    .filter((e): e is string => e !== null && e !== undefined) as string[];

  const integration = await repo.findIntegrationById(credential.integrationId);
  await repo.updateIntegration(credential.integrationId, {
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: mergeJson(integration?.config ?? null, {
      provider: providerKey,
      lastConnectedAt: new Date().toISOString(),
      scopes: tokenResult.scopes,
      connectedEmail: tokenResult.userEmail,
      connectedEmails,
    }),
  });

  const displayEmail =
    tokenResult.userEmail !== undefined &&
    tokenResult.userEmail !== null &&
    tokenResult.userEmail !== ''
      ? ` (${tokenResult.userEmail})`
      : '';
  log.info('Gmail OAuth complete', { credentialId: credential.id, status: 'CONNECTED' });
  sendOAuthResult(res, {
    success: grant.complete,
    message: grant.complete
      ? `Successfully connected ${providerKey.toUpperCase()}${displayEmail}.`
      : 'Google did not grant all requested permissions. Reconnect Google.',
    returnUrl,
    errorUrl,
  });
  if (grant.complete) await onCompleteGrant(credential.userId, providerKey);

  if (grant.complete) {
    maybeSyncGmailAfterOAuth({
      providerKey,
      accessToken: tokenResult.accessToken,
      userEmail: tokenResult.userEmail,
      userId: credential.userId,
      integrationId: credential.integrationId,
      credentialId: credential.id,
    });
  }
}

/** Validate credential and extract metadata URLs. Returns null + sends error if invalid. */
async function validateOAuthCredential(
  providerKey: EmailProviderSlug,
  state: string,
  res: OAuthResponse
) {
  const config = EMAIL_PROVIDER_CONFIG[providerKey];
  if (config.clientId === undefined || config.clientId === '') {
    sendOAuthResult(res, { success: false, message: `Missing client ID for ${providerKey}` });
    return null;
  }

  const credential = await repo.findCredentialByState(config.provider, state);
  if (credential === null || credential === undefined) {
    sendOAuthResult(res, {
      success: false,
      message: 'No pending OAuth request found or state mismatch',
    });
    return null;
  }

  const metadata = credential.metadata as Record<string, unknown> | null;
  const returnUrl = typeof metadata?.returnUrl === 'string' ? metadata.returnUrl : null;
  const errorUrl = typeof metadata?.errorUrl === 'string' ? metadata.errorUrl : null;

  if (
    credential.pkceVerifier === null ||
    credential.pkceVerifier === undefined ||
    credential.pkceVerifier === ''
  ) {
    sendOAuthResult(res, {
      success: false,
      message: 'Missing PKCE verifier for this request',
      returnUrl,
      errorUrl,
    });
    return null;
  }

  return { config, credential, returnUrl, errorUrl };
}

/**
 * Handle the OAuth callback: exchange code, update credentials, sync emails.
 */
export async function handleOAuthCallback(
  providerKey: EmailProviderSlug,
  code: string,
  state: string,
  res: OAuthResponse
) {
  const validated = await validateOAuthCredential(providerKey, state, res);
  if (validated === null) return;
  const { config, credential, returnUrl, errorUrl } = validated;

  const redirectUri = buildRedirectUri(providerKey);
  const tokenResult = await exchangeProviderCode(providerKey, {
    code,
    codeVerifier: credential.pkceVerifier!,
    redirectUri,
  });

  const expiresAt =
    tokenResult.expiresIn !== undefined && tokenResult.expiresIn !== null
      ? new Date(Date.now() + tokenResult.expiresIn * 1000)
      : null;

  // Check if this email is already connected
  if (
    tokenResult.userEmail !== undefined &&
    tokenResult.userEmail !== null &&
    tokenResult.userEmail !== ''
  ) {
    const existingCredential = await repo.findExistingCredential({
      userId: credential.userId,
      provider: config.provider,
      email: tokenResult.userEmail,
      excludeId: credential.id,
    });

    if (existingCredential !== null && existingCredential !== undefined) {
      return handleExistingEmail(
        credential.userId,
        tokenResult,
        existingCredential.id,
        credential.id,
        existingCredential.integrationId,
        existingCredential.refreshToken,
        existingCredential.metadata,
        providerKey,
        tokenResult.userEmail,
        expiresAt,
        res,
        returnUrl,
        errorUrl
      );
    }
  }

  await finalizeNewCredential(
    credential,
    tokenResult,
    expiresAt,
    config.provider,
    providerKey,
    res,
    returnUrl,
    errorUrl
  );
}
