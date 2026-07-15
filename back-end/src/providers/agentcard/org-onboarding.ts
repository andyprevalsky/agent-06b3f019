import { callOrgTool } from './org-runtime';
import {
  getOrgManagedCardholderId,
  getOrgOnboardingConfig,
  saveOrgCardholderId,
  saveOrgOnboardingConfig,
  type OrgOnboardingConfig,
} from './store';

type McpResult = {
  structuredContent?: unknown;
  toolResult?: unknown;
  content?: Array<{ type: string; text?: string }>;
};

export interface OrgCardholderStatus {
  connected: boolean;
  cardholderId?: string;
  status?: string;
  setupUrl?: string;
  setupSessionId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function resultRecord(result: unknown): Record<string, unknown> {
  const envelope = result as McpResult;
  const direct = asRecord(envelope.toolResult) ?? asRecord(envelope.structuredContent);
  if (direct !== undefined) return direct;
  const text = (envelope.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  if (text !== '') {
    try {
      return asRecord(JSON.parse(text)) ?? { message: text };
    } catch {
      return { message: text };
    }
  }
  return {};
}

function stringField(record: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function onboardingReturnUrl(): string {
  const explicit = process.env.AGENTCARD_ONBOARDING_RETURN_URL?.trim();
  if (explicit) return explicit;
  const publicUrl = process.env.AGENTCARD_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (!publicUrl) {
    throw new Error('Missing AGENTCARD_ONBOARDING_RETURN_URL or AGENTCARD_PUBLIC_URL');
  }
  return `${publicUrl}/api/agentcard/onboarding/callback`;
}

function isExpired(config: OrgOnboardingConfig): boolean {
  if (config.expiresAt === undefined) return false;
  const expiresAt = Date.parse(config.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

export async function startOrgCardholderOnboarding(userId: string): Promise<OrgOnboardingConfig> {
  const existing = await getOrgOnboardingConfig(userId);
  if (existing !== undefined && !isExpired(existing)) return existing;

  const result = await callOrgTool('create_onboarding_session', {
    return_url: onboardingReturnUrl(),
    external_user_id: userId,
    state: userId,
  });
  const record = resultRecord(result);
  const sessionId = stringField(record, ['session_id', 'sessionId', 'id']);
  const setupUrl = stringField(record, ['url', 'setup_url', 'setupUrl', 'onboarding_url']);
  if (sessionId === undefined || setupUrl === undefined) {
    throw new Error('AgentCard onboarding session response missing session id or URL');
  }
  const onboarding = {
    sessionId,
    setupUrl,
    ...(() => {
      const expiresAt = stringField(record, ['expires_at', 'expiresAt']);
      return expiresAt !== undefined ? { expiresAt } : {};
    })(),
  };
  await saveOrgOnboardingConfig(userId, onboarding);
  return onboarding;
}

export async function refreshOrgCardholderStatus(userId: string): Promise<OrgCardholderStatus> {
  const cardholderId = await getOrgManagedCardholderId(userId);
  if (cardholderId !== undefined) {
    const result = resultRecord(
      await callOrgTool('get_cardholder_kyc_status', { cardholder_id: cardholderId })
    );
    const status = stringField(result, ['status', 'kyc_status', 'kycStatus']);
    return {
      connected: status === 'verified',
      cardholderId,
      status: status ?? 'unknown',
    };
  }

  const onboarding = await getOrgOnboardingConfig(userId);
  if (onboarding === undefined) return { connected: false };
  const result = resultRecord(
    await callOrgTool('get_onboarding_session', { session_id: onboarding.sessionId })
  );
  const status = stringField(result, ['status']) ?? 'pending';
  const completedCardholderId = stringField(result, ['cardholder_id', 'cardholderId']);
  if (status === 'completed' && completedCardholderId !== undefined) {
    await saveOrgCardholderId(userId, completedCardholderId);
    return { connected: true, cardholderId: completedCardholderId, status };
  }
  return {
    connected: false,
    status,
    setupUrl: onboarding.setupUrl,
    setupSessionId: onboarding.sessionId,
  };
}

export async function completeOrgCardholderOnboarding(
  userId: string,
  sessionId: string
): Promise<string> {
  const result = resultRecord(
    await callOrgTool('get_onboarding_session', { session_id: sessionId })
  );
  const externalUserId = stringField(result, ['external_user_id', 'externalUserId']);
  if (externalUserId !== undefined && externalUserId !== userId) {
    throw new Error('AgentCard onboarding session does not belong to this user');
  }
  const status = stringField(result, ['status']);
  const cardholderId = stringField(result, ['cardholder_id', 'cardholderId']);
  if (status !== 'completed' || cardholderId === undefined) {
    throw new Error(`AgentCard onboarding session is not complete (${status ?? 'unknown'})`);
  }
  await saveOrgCardholderId(userId, cardholderId);
  return cardholderId;
}
