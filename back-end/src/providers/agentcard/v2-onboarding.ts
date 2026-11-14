import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { agentCardV2Request } from './api-v2';
import { signConnectToken } from './config';
import { getV2ConnectedUserId, saveV2ConnectedUserId, getV2CredentialClientId } from './store';
import { getEphemeral, putEphemeral, withSerializedLock } from '../sharedState';

// Rose -> signed form -> connect/start -> OTP verify -> consent -> exclusive v2UserId -> KYC.
// Only server responses supply provider ids. Connection tokens are deliberately discarded:
// all REST calls use the org token, and legacy MCP cleanup retains its existing credentials.
const NAMESPACE = 'agentcard-v2-connect';
const TTL_MS = 10 * 60 * 1000;
interface ConnectSession {
  userId: string;
  clientId: string;
  expiresAt: number;
  connectId?: string;
  verifiedUserId?: string;
  consented?: boolean;
  completed?: boolean;
}

export interface V2OnboardingDependencies {
  request: typeof agentCardV2Request;
  put: typeof putEphemeral;
  get: typeof getEphemeral;
  lock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  now: () => number;
  randomId: () => string;
  getConnectedUserId: (userId: string) => Promise<string | undefined>;
  saveConnectedUserId: (userId: string, v2UserId: string) => Promise<void>;
}

const defaults: V2OnboardingDependencies = {
  request: agentCardV2Request,
  put: putEphemeral,
  get: getEphemeral,
  lock: (key, fn) => withSerializedLock(key, fn),
  now: Date.now,
  randomId: randomUUID,
  getConnectedUserId: getV2ConnectedUserId,
  saveConnectedUserId: saveV2ConnectedUserId,
};

function setupUrl(userId: string, sessionId: string, now: number): string {
  const base = process.env.AGENTCARD_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (!base) throw new Error('Missing AGENTCARD_PUBLIC_URL');
  const params = new URLSearchParams({
    user: userId,
    session: sessionId,
    t: signConnectToken(userId, now),
  });
  return `${base}/api/agentcard/v2/connect?${params}`;
}

export async function getV2ConnectSession(
  userId: string,
  sessionId: string,
  dependencies: Partial<V2OnboardingDependencies> = {}
): Promise<ConnectSession> {
  const deps = { ...defaults, ...dependencies };
  const session = await deps.get<ConnectSession>(NAMESPACE, sessionId);
  if (
    !session ||
    session.userId !== userId ||
    session.clientId !== getV2CredentialClientId() ||
    session.expiresAt <= deps.now()
  ) {
    throw new Error('Invalid, expired or unowned AgentCard setup session');
  }
  return session;
}

async function saveSession(
  id: string,
  session: ConnectSession,
  deps: V2OnboardingDependencies
): Promise<void> {
  const ttl = session.expiresAt - deps.now();
  if (ttl <= 0) throw new Error('AgentCard setup session expired');
  await deps.put(NAMESPACE, id, session as unknown as Prisma.InputJsonObject, ttl);
}

/** Creates only a signed local form. No provider call or email happens until the user submits. */
export async function startV2Onboarding(
  userId: string,
  dependencies: Partial<V2OnboardingDependencies> = {}
): Promise<{ sessionId: string; setupUrl: string }> {
  const deps = { ...defaults, ...dependencies };
  if (!userId.trim()) throw new Error('Rose user id is required');
  return deps.lock(`agentcard:v2:setup:${userId}`, async () => {
    const pending = await deps.get<{ sessionId: string }>(NAMESPACE, `user:${userId}`);
    if (pending !== undefined) {
      const existing = await deps.get<ConnectSession>(NAMESPACE, pending.sessionId);
      if (
        existing?.userId === userId &&
        existing.clientId === getV2CredentialClientId() &&
        existing.expiresAt > deps.now()
      ) {
        return {
          sessionId: pending.sessionId,
          setupUrl: setupUrl(userId, pending.sessionId, existing.expiresAt - TTL_MS),
        };
      }
    }
    const sessionId = deps.randomId();
    const createdAt = deps.now();
    const url = setupUrl(userId, sessionId, createdAt);
    await saveSession(
      sessionId,
      { userId, clientId: getV2CredentialClientId(), expiresAt: createdAt + TTL_MS },
      deps
    );
    await deps.put(NAMESPACE, `user:${userId}`, { sessionId }, TTL_MS);
    return { sessionId, setupUrl: url };
  });
}

export async function startV2Connection(
  userId: string,
  sessionId: string,
  contact: { email?: string; phone?: string },
  dependencies: Partial<V2OnboardingDependencies> = {}
): Promise<void> {
  const deps = { ...defaults, ...dependencies };
  await deps.lock(`agentcard:v2:session:${sessionId}`, async () => {
    const session = await getV2ConnectSession(userId, sessionId, deps);
    const email = contact.email?.trim();
    const phone = contact.phone?.trim();
    if (Boolean(email) === Boolean(phone)) throw new Error('Provide exactly one email or phone');
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
      throw new Error('Invalid email');
    if (phone && !/^\+[1-9][0-9]{6,14}$/.test(phone)) throw new Error('Invalid phone');
    // A refresh/double-submit must not send another email or swap the verified identity.
    if (session.connectId || session.verifiedUserId) return;
    const result = await deps.request('POST', '/api/v2/connect/start', {
      ...(email ? { email } : { phone }),
      external_user_id: userId,
    });
    // OpenAPI ConnectAttempt.id is the response field; connect_id is the VERIFY request field.
    if (typeof result.id !== 'string' || !result.id.trim())
      throw new Error('Invalid AgentCard connect response');
    session.connectId = result.id;
    await saveSession(sessionId, session, deps);
  });
}

export async function verifyV2Connection(
  userId: string,
  sessionId: string,
  code: string,
  consent: boolean,
  dependencies: Partial<V2OnboardingDependencies> = {}
): Promise<void> {
  const deps = { ...defaults, ...dependencies };
  await deps.lock(`agentcard:v2:session:${sessionId}`, async () => {
    const session = await getV2ConnectSession(userId, sessionId, deps);
    if (!consent) throw new Error('Consent is required');
    if (!session.connectId) throw new Error('Start the connection before verifying');
    if (!session.verifiedUserId) {
      if (!/^[0-9]{4,12}$/.test(code)) throw new Error('Invalid verification code');
      const result = await deps.request('POST', '/api/v2/connect/verify', {
        connect_id: session.connectId,
        code,
      });
      const user = result.user as Record<string, unknown> | undefined;
      if (typeof user?.id !== 'string' || !user.id.trim())
        throw new Error('AgentCard verify response missing user.id');
      session.verifiedUserId = user.id;
      // OTPs are single-use. Persist the verified id before consent so a retry does not reuse it.
      await saveSession(sessionId, session, deps);
    }
    if (!session.consented) {
      await deps.request('POST', '/api/v2/connect/consent', { user_id: session.verifiedUserId });
      session.consented = true;
      await saveSession(sessionId, session, deps);
    }
    await deps.saveConnectedUserId(userId, session.verifiedUserId);
    session.completed = true;
    await saveSession(sessionId, session, deps);
  });
}

export interface V2OnboardingStatus {
  connected: boolean;
  status: string;
  livemode?: boolean;
  fundsSource?: string;
  setupUrl?: string;
  setupSessionId?: string;
}

export async function refreshV2OnboardingStatus(
  userId: string,
  dependencies: Partial<V2OnboardingDependencies> = {}
): Promise<V2OnboardingStatus | undefined> {
  if (!process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID?.trim()) return undefined;
  const deps = { ...defaults, ...dependencies };
  const v2UserId = await deps.getConnectedUserId(userId);
  if (v2UserId) {
    const wallet = await deps.request('GET', '/api/v2/company_wallet');
    const mode = {
      ...(typeof wallet.livemode === 'boolean' ? { livemode: wallet.livemode } : {}),
      ...(typeof wallet.default_funds_source === 'string'
        ? { fundsSource: wallet.default_funds_source }
        : {}),
    };
    // Credential-mode proof comes from the provider, never the environment or browser.
    // Company-funded sandbox cards do not require KYC; avoid an unnecessary hosted flow.
    if (wallet.livemode === false && wallet.default_funds_source === 'company_flow') {
      return { connected: true, status: 'sandbox_ready', ...mode };
    }
    const result = await deps.request('GET', `/api/v2/kyc?user_id=${encodeURIComponent(v2UserId)}`);
    const status = typeof result.status === 'string' ? result.status : 'unknown';
    const actionable = [
      'awaiting_documents',
      'needs_information',
      'requires_verification',
    ].includes(status);
    const url = typeof result.iframe_url === 'string' ? result.iframe_url : undefined;
    return {
      connected: status === 'approved',
      status,
      ...mode,
      ...(actionable && url ? { setupUrl: url } : {}),
    };
  }
  const pending = await deps.get<{ sessionId: string }>(NAMESPACE, `user:${userId}`);
  if (!pending) return undefined;
  const session = await deps.get<ConnectSession>(NAMESPACE, pending.sessionId);
  if (
    !session ||
    session.userId !== userId ||
    session.clientId !== getV2CredentialClientId() ||
    session.expiresAt <= deps.now()
  )
    return undefined;
  return {
    connected: false,
    status: 'connection_required',
    setupSessionId: pending.sessionId,
    setupUrl: setupUrl(userId, pending.sessionId, session.expiresAt - TTL_MS),
  };
}

export { getV2ConnectedUserId } from './store';

/** Read-only fixture admission. Never derives a v2 user id from an MCP cardholder id. */
export async function validateV2SandboxFixtureUser(
  v2UserId: string,
  request: typeof agentCardV2Request = agentCardV2Request
): Promise<void> {
  if (!/^usr_[A-Za-z0-9_-]+$/.test(v2UserId)) {
    throw new Error(
      'BENCHMARK_AGENTCARD_V2_USER_ID must be a connected sandbox user.id (usr_...), never a cardholderId'
    );
  }
  const wallet = await request('GET', '/api/v2/company_wallet');
  if (wallet.livemode !== false || wallet.default_funds_source !== 'company_flow') {
    throw new Error('v2 sandbox fixture requires verified sandbox credentials and company funding');
  }
  // This endpoint requires an existing connection in the credential's org and mode.
  // Company-funded sandbox cards can be issued without an approved KYC result.
  const kyc = await request('GET', `/api/v2/kyc?user_id=${encodeURIComponent(v2UserId)}`);
  if (
    typeof kyc.status !== 'string' ||
    ![
      'awaiting_documents',
      'needs_information',
      'requires_verification',
      'pending',
      'approved',
      'rejected',
    ].includes(kyc.status)
  ) {
    throw new Error('AgentCard did not return a valid connected sandbox KYC status');
  }
}
