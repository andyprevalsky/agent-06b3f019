/**
 * AgentCard connect-flow orchestration: mint the authorize URL, handle the OAuth
 * callback, and report per-user connection status.
 */

import { createLogger } from '../../providers/logger';
import { refreshV2OnboardingStatus } from '../../providers/agentcard/v2-onboarding';
import { loadOAuthConfig } from '../../providers/agentcard/config';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generatePkce,
  generateState,
  isExpired,
} from '../../providers/agentcard/oauth';
import {
  getUserToken,
  putPendingAuth,
  saveUserToken,
  takePendingAuth,
} from '../../providers/agentcard/store';
import {
  completeOrgCardholderOnboarding,
  refreshOrgCardholderStatus,
} from '../../providers/agentcard/org-onboarding';

const log = createLogger('AgentCard');

function maskId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/** Part 2 start: build "Connect with AgentCard" URL and stash the PKCE verifier. */
export async function startConnect(userId: string): Promise<{ authUrl: string; state: string }> {
  const { clientId, redirectUri } = loadOAuthConfig();
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  await putPendingAuth(state, userId, verifier);
  const authUrl = buildAuthorizeUrl({ clientId, redirectUri, challenge, state });
  log.info('AgentCard connect started', { user_id: maskId(userId) });
  return { authUrl, state };
}

/** Part 2 finish: exchange the code for tokens and persist them for the user. */
export async function handleCallback(code: string, state: string): Promise<{ userId: string }> {
  const pendingAuth = await takePendingAuth(state);
  if (pendingAuth === undefined) {
    throw new Error('Unknown or expired OAuth state');
  }
  const { clientId, clientSecret, redirectUri } = loadOAuthConfig();
  const token = await exchangeCodeForToken({
    code,
    redirectUri,
    clientId,
    clientSecret,
    verifier: pendingAuth.verifier,
  });
  await saveUserToken(pendingAuth.userId, token);
  log.info('AgentCard connected', { user_id: maskId(pendingAuth.userId) });
  return { userId: pendingAuth.userId };
}

export interface AgentCardStatus {
  connected: boolean;
  apiVersion?: 2;
  livemode?: boolean;
  fundsSource?: string;
  expiresAt?: string;
  expired?: boolean;
  status?: string;
  setupUrl?: string;
  setupSessionId?: string;
}

export async function getStatus(
  userId: string,
  dependencies: Partial<{
    refreshV2OnboardingStatus: typeof refreshV2OnboardingStatus;
    refreshOrgCardholderStatus: typeof refreshOrgCardholderStatus;
    getUserToken: typeof getUserToken;
  }> = {}
): Promise<AgentCardStatus> {
  const deps = {
    refreshV2OnboardingStatus,
    refreshOrgCardholderStatus,
    getUserToken,
    ...dependencies,
  };
  const v2Status = await deps.refreshV2OnboardingStatus(userId);
  if (v2Status !== undefined) return { ...v2Status, apiVersion: 2 };
  const [orgStatus, token] = await Promise.all([
    deps.refreshOrgCardholderStatus(userId),
    deps.getUserToken(userId),
  ]);
  const orgFields = {
    ...(orgStatus.status !== undefined ? { status: orgStatus.status } : {}),
    ...(orgStatus.setupUrl !== undefined ? { setupUrl: orgStatus.setupUrl } : {}),
    ...(orgStatus.setupSessionId !== undefined ? { setupSessionId: orgStatus.setupSessionId } : {}),
  };
  // A valid per-user OAuth token is a usable connection the routing provider can
  // still use, even while org onboarding is pending. Don't let a pending
  // organization status mask it — surface the token connection and merge the
  // organization onboarding fields alongside it.
  if (token !== undefined) {
    return {
      connected: true,
      expiresAt: new Date(token.expiresAt).toISOString(),
      expired: isExpired(token, 0),
      ...orgFields,
    };
  }
  if (orgStatus.connected || orgStatus.status !== undefined || orgStatus.setupUrl !== undefined) {
    return { connected: orgStatus.connected, ...orgFields };
  }
  return { connected: false };
}

export async function handleOnboardingCallback(
  userId: string,
  sessionId: string
): Promise<{ cardholderId: string }> {
  const cardholderId = await completeOrgCardholderOnboarding(userId, sessionId);
  log.info('AgentCard org cardholder onboarding completed', {
    user_id: maskId(userId),
    cardholder_id: maskId(cardholderId),
  });
  return { cardholderId };
}
