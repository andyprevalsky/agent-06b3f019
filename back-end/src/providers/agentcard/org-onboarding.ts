import { callOrgTool } from './org-runtime';
import {
  getOrgManagedCardholderId,
  getOrgOnboardingConfig,
  saveOrgCardholderId,
  saveOrgOnboardingConfig,
  type OrgOnboardingConfig,
} from './store';

type McpResult = {
  isError?: boolean;
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

function resultText(result: unknown): string {
  const envelope = result as McpResult;
  return (envelope.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function resultRecord(result: unknown): Record<string, unknown> {
  const envelope = result as McpResult;
  const direct = asRecord(envelope.toolResult) ?? asRecord(envelope.structuredContent);
  const text = resultText(result);
  const status = direct?.status;
  if (envelope.isError === true || status === 'error') {
    const message =
      direct === undefined ? undefined : stringField(direct, ['message', 'error', 'detail']);
    throw new Error(message ?? (text || 'AgentCard Organization MCP tool failed'));
  }
  if (direct !== undefined) return direct;
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

export async function startOrgCardholderOnboarding(
  userId: string,
  dependencies: Partial<OrgOnboardingDependencies> = {}
): Promise<OrgOnboardingConfig> {
  const deps = { ...defaultOnboardingDependencies, ...dependencies };
  const existing = await deps.getOrgOnboardingConfig(userId);
  if (existing !== undefined && !isExpired(existing)) return existing;

  const result = await deps.callOrgTool('create_onboarding_session', {
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
  await deps.saveOrgOnboardingConfig(userId, onboarding);
  return onboarding;
}

export interface OrgOnboardingDependencies {
  callOrgTool: typeof callOrgTool;
  getOrgManagedCardholderId: typeof getOrgManagedCardholderId;
  getOrgOnboardingConfig: typeof getOrgOnboardingConfig;
  saveOrgCardholderId: typeof saveOrgCardholderId;
  saveOrgOnboardingConfig: typeof saveOrgOnboardingConfig;
}

const defaultOnboardingDependencies: OrgOnboardingDependencies = {
  callOrgTool,
  getOrgManagedCardholderId,
  getOrgOnboardingConfig,
  saveOrgCardholderId,
  saveOrgOnboardingConfig,
};

export async function getOrgCardholderVerificationStatus(
  cardholderId: string,
  dependencies: Partial<Pick<OrgOnboardingDependencies, 'callOrgTool'>> = {}
): Promise<string> {
  const trimmedCardholderId = cardholderId.trim();
  if (trimmedCardholderId === '') throw new Error('AgentCard cardholder id is required');
  const callTool = dependencies.callOrgTool ?? defaultOnboardingDependencies.callOrgTool;
  const result = resultRecord(
    await callTool('get_cardholder_kyc_status', { cardholder_id: trimmedCardholderId })
  );
  // Prefer the KYC-specific keys over a generic transport `status`: a payload
  // carrying both (e.g. status:"ok" + kyc_status:"verified") must report the
  // terminal KYC state, not the transport state, or a verified cardholder is
  // wrongly treated as not ready.
  return stringField(result, ['kyc_status', 'kycStatus', 'status']) ?? 'unknown';
}

export async function refreshOrgCardholderStatus(
  userId: string,
  dependencies: Partial<OrgOnboardingDependencies> = {}
): Promise<OrgCardholderStatus> {
  const deps = { ...defaultOnboardingDependencies, ...dependencies };
  const cardholderId = await deps.getOrgManagedCardholderId(userId);
  if (cardholderId !== undefined) {
    const result = resultRecord(
      await deps.callOrgTool('get_cardholder_kyc_status', { cardholder_id: cardholderId })
    );
    const status = stringField(result, ['status', 'kyc_status', 'kycStatus']);
    return {
      // `mintCard()` accepts both terminal KYC states, so report both as connected.
      connected: status === 'verified' || status === 'approved',
      cardholderId,
      status: status ?? 'unknown',
    };
  }

  const onboarding = await deps.getOrgOnboardingConfig(userId);
  if (onboarding === undefined) return { connected: false };
  let sessionResult: unknown;
  try {
    sessionResult = await deps.callOrgTool('get_onboarding_session', {
      session_id: onboarding.sessionId,
    });
  } catch (error) {
    // Benchmark/reset races and expired hosted sessions leave a stale session id. Surface as
    // disconnected instead of 500'ing GET /api/agentcard/status.
    const message = error instanceof Error ? error.message : String(error);
    if (/onboarding session not found|session not found/i.test(message)) {
      return {
        connected: false,
        status: 'session_not_found',
        setupUrl: onboarding.setupUrl,
        setupSessionId: onboarding.sessionId,
      };
    }
    throw error;
  }
  const result = resultRecord(sessionResult);
  const status = stringField(result, ['status']) ?? 'pending';
  const completedCardholderId = stringField(result, ['cardholder_id', 'cardholderId']);
  if (status === 'completed' && completedCardholderId !== undefined) {
    await deps.saveOrgCardholderId(userId, completedCardholderId);
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
  sessionId: string,
  dependencies: Partial<OrgOnboardingDependencies> = {}
): Promise<string> {
  const deps = { ...defaultOnboardingDependencies, ...dependencies };
  // Bind the callback to the session THIS user actually started. Without this, any completed session
  // whose response omits `external_user_id` could be bound to the current user.
  const persisted = await deps.getOrgOnboardingConfig(userId);
  if (persisted === undefined || persisted.sessionId !== sessionId) {
    throw new Error('AgentCard onboarding session does not belong to this user');
  }
  const result = resultRecord(
    await deps.callOrgTool('get_onboarding_session', { session_id: sessionId })
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
  await deps.saveOrgCardholderId(userId, cardholderId);
  return cardholderId;
}
