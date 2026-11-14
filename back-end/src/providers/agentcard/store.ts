/**
 * AgentCard token + PKCE-state store.
 *
 *  - Per-user tokens are persisted via repo.ts (Integration row, name="agentcard"),
 *    keyed by the stable Supabase userId. This module owns (de)serialization.
 *  - The transient state -> {userId, verifier} map lives in SharedEphemeralState
 *    (10-minute TTL) so any instance can complete a connect another started.
 */

import type { Prisma } from '@prisma/client';
import type { TokenSet } from './oauth';
import type { StoredTokenConfig } from './types';
import * as repo from './repo';
import { putEphemeral, takeEphemeral } from '../sharedState';

// ---------------------------------------------------------------------------
// PKCE state (state -> { userId, verifier }), shared by every backend instance:
// the OAuth callback can land on a different instance than the connect start.
// ---------------------------------------------------------------------------

interface PendingAuth {
  userId: string;
  verifier: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const PKCE_NAMESPACE = 'agentcard-pkce';

export async function putPendingAuth(
  state: string,
  userId: string,
  verifier: string
): Promise<void> {
  await putEphemeral(
    PKCE_NAMESPACE,
    state,
    { userId, verifier, createdAt: Date.now() },
    PENDING_TTL_MS
  );
}

/** Consumes (single-use, across instances) the pending auth for a given state. */
export async function takePendingAuth(state: string): Promise<PendingAuth | undefined> {
  return takeEphemeral<PendingAuth>(PKCE_NAMESPACE, state);
}

// ---------------------------------------------------------------------------
// Persisted per-user token bundle
// ---------------------------------------------------------------------------

/** JSON-safe token bundle stored in `Integration.config` (no `undefined` values). */
function toStored(token: TokenSet): StoredTokenConfig {
  const config: StoredTokenConfig = {
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    expiresAt: token.expiresAt,
    obtainedAt: new Date().toISOString(),
  };
  if (token.refreshToken !== undefined) config.refreshToken = token.refreshToken;
  if (token.scope !== undefined) config.scope = token.scope;
  return config;
}

function fromStored(config: unknown): TokenSet | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const c = config as Record<string, unknown>;
  if (typeof c.accessToken !== 'string' || c.accessToken === '') return undefined;
  if (typeof c.expiresAt !== 'number') return undefined;
  return {
    accessToken: c.accessToken,
    refreshToken: typeof c.refreshToken === 'string' ? c.refreshToken : undefined,
    tokenType: typeof c.tokenType === 'string' ? c.tokenType : 'bearer',
    expiresAt: c.expiresAt,
    scope: typeof c.scope === 'string' ? c.scope : undefined,
  };
}

export async function saveUserToken(userId: string, token: TokenSet): Promise<void> {
  await repo.saveTokenConfig(userId, toStored(token));
}

export async function getUserToken(userId: string): Promise<TokenSet | undefined> {
  return fromStored(await repo.findTokenConfig(userId));
}

export async function getOrgManagedCardholderId(userId: string): Promise<string | undefined> {
  const config = await repo.findConnectedConfig(userId);
  if (typeof config !== 'object' || config === null) return undefined;
  const record = config as Record<string, unknown>;
  return record.orgManaged === true &&
    typeof record.cardholderId === 'string' &&
    record.cardholderId.trim() !== ''
    ? record.cardholderId
    : undefined;
}

/** v2 user ids are a separate provider identity; legacy cardholder ids are never aliases. */
export function getV2CredentialClientId(): string {
  const id = process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID?.trim();
  if (!id) throw new Error('Missing AGENTCARD_ORG_OAUTH_CLIENT_ID for v2 identity scope');
  return id;
}

export async function getV2ConnectedUserId(
  userId: string,
  deps: Pick<typeof repo, 'findConnectedConfig'> = repo
): Promise<string | undefined> {
  const clientId = process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  const config = configRecord(await deps.findConnectedConfig(userId));
  const id = configRecord(config.v2Bindings)[clientId];
  return typeof id === 'string' && id.trim() !== '' ? id : undefined;
}

export class AgentCardV2BindingConflictError extends Error {
  constructor() {
    super('AgentCard connection is already bound to a different user');
    this.name = 'AgentCardV2BindingConflictError';
  }
}

export async function saveV2ConnectedUserId(
  userId: string,
  v2UserId: string,
  deps: Pick<typeof repo, 'bindV2UserExclusively'> = repo
): Promise<void> {
  if (userId.trim() === '' || v2UserId.trim() === '') {
    throw new Error('Rose and AgentCard user ids are required');
  }
  const clientId = getV2CredentialClientId();
  const result = await deps.bindV2UserExclusively(
    userId,
    v2UserId,
    (existing) => {
      const config = configRecord(existing);
      const bindings = configRecord(config.v2Bindings);
      // Reconnecting must not silently switch the identity owning existing cards.
      if (typeof bindings[clientId] === 'string' && bindings[clientId] !== v2UserId) {
        throw new AgentCardV2BindingConflictError();
      }
      return {
        ...config,
        v2UserId,
        v2ClientId: clientId,
        v2Bindings: { ...bindings, [clientId]: v2UserId },
      } as Prisma.InputJsonObject;
    },
    clientId
  );
  if (result.conflictingUserId !== undefined) throw new AgentCardV2BindingConflictError();
}

export interface OrgOnboardingConfig {
  sessionId: string;
  setupUrl: string;
  expiresAt?: string;
}

function configRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export async function getOrgOnboardingConfig(
  userId: string
): Promise<OrgOnboardingConfig | undefined> {
  const config = configRecord(await repo.findTokenConfig(userId));
  if (
    config.orgManaged !== true ||
    typeof config.onboardingSessionId !== 'string' ||
    typeof config.onboardingSetupUrl !== 'string'
  ) {
    return undefined;
  }
  return {
    sessionId: config.onboardingSessionId,
    setupUrl: config.onboardingSetupUrl,
    ...(typeof config.onboardingExpiresAt === 'string'
      ? { expiresAt: config.onboardingExpiresAt }
      : {}),
  };
}

export async function saveOrgOnboardingConfig(
  userId: string,
  onboarding: OrgOnboardingConfig,
  deps: Pick<typeof repo, 'findTokenConfig' | 'saveIntegrationConfig'> = repo
): Promise<void> {
  const existing = configRecord(await deps.findTokenConfig(userId));
  const config: Prisma.InputJsonObject = {
    ...existing,
    orgManaged: true,
    onboardingSessionId: onboarding.sessionId,
    onboardingSetupUrl: onboarding.setupUrl,
    ...(onboarding.expiresAt !== undefined ? { onboardingExpiresAt: onboarding.expiresAt } : {}),
  } as Prisma.InputJsonObject;
  await deps.saveIntegrationConfig(userId, config, false);
}

export class AgentCardCardholderConflictError extends Error {
  readonly cardholderId: string;
  readonly ownerUserId: string;

  constructor(cardholderId: string, ownerUserId: string, userId: string) {
    super(
      `AgentCard cardholder ${cardholderId} is already bound to user ${ownerUserId}; ` +
        `refusing to also bind it to ${userId}`
    );
    this.name = 'AgentCardCardholderConflictError';
    this.cardholderId = cardholderId;
    this.ownerUserId = ownerUserId;
  }
}

/**
 * Bind a user to an org-managed cardholder, enforcing 1 user : 1 cardholder : 1 wallet.
 *
 * A cardholder owns a funding wallet and issues MANY cards from it (one per purchase). Binding a
 * second user to the same cardholder makes those users share one wallet and spend each other's
 * funds. That is exactly how a benchmark fixture user ended up bound to a live cardholder in
 * prod, so this refuses rather than silently overwriting.
 */
export interface SaveOrgCardholderDeps {
  bindCardholderExclusively: (
    userId: string,
    cardholderId: string,
    buildConfig: (existing: unknown | undefined) => Prisma.InputJsonObject
  ) => Promise<{ conflictingUserId?: string }>;
}

/**
 * The ownership check and the write happen inside ONE advisory-locked transaction
 * (`repo.bindCardholderExclusively`). Doing the check here and the write separately would let two
 * concurrent calls for different users both see "unowned" and both bind — the exact commingled
 * wallet this guard exists to prevent, and one no unique index can catch afterwards because the
 * binding lives in a JSON column.
 */
export async function saveOrgCardholderId(
  userId: string,
  cardholderId: string,
  deps: SaveOrgCardholderDeps = repo
): Promise<void> {
  const { conflictingUserId } = await deps.bindCardholderExclusively(
    userId,
    cardholderId,
    (existing) => {
      const config = configRecord(existing);
      delete config.onboardingSessionId;
      delete config.onboardingSetupUrl;
      delete config.onboardingExpiresAt;
      return { ...config, orgManaged: true, cardholderId } as Prisma.InputJsonObject;
    }
  );
  if (conflictingUserId !== undefined) {
    throw new AgentCardCardholderConflictError(cardholderId, conflictingUserId, userId);
  }
}

export async function clearUserToken(userId: string): Promise<void> {
  await repo.clearToken(userId);
}
