/**
 * AgentCard token + PKCE-state store.
 *
 *  - Per-user tokens are persisted via repo.ts (Integration row, name="agentcard"),
 *    keyed by the stable Supabase userId. This module owns (de)serialization.
 *  - The transient state -> {userId, verifier} map is in-memory (short-lived; a
 *    connect flow completes within minutes).
 */

import type { Prisma } from '@prisma/client';
import type { TokenSet } from './oauth';
import type { StoredTokenConfig } from './types';
import * as repo from './repo';

// ---------------------------------------------------------------------------
// In-memory PKCE state map (state -> { userId, verifier })
// ---------------------------------------------------------------------------

interface PendingAuth {
  userId: string;
  verifier: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, PendingAuth>();

function prunePending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [state, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(state);
  }
}

export function putPendingAuth(state: string, userId: string, verifier: string): void {
  prunePending();
  pending.set(state, { userId, verifier, createdAt: Date.now() });
}

/** Consumes (single-use) the pending auth for a given state. */
export function takePendingAuth(state: string): PendingAuth | undefined {
  prunePending();
  const entry = pending.get(state);
  if (entry !== undefined) pending.delete(state);
  return entry;
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
  onboarding: OrgOnboardingConfig
): Promise<void> {
  const existing = configRecord(await repo.findTokenConfig(userId));
  const config: Prisma.InputJsonObject = {
    ...existing,
    orgManaged: true,
    onboardingSessionId: onboarding.sessionId,
    onboardingSetupUrl: onboarding.setupUrl,
    ...(onboarding.expiresAt !== undefined
      ? { onboardingExpiresAt: onboarding.expiresAt }
      : {}),
  } as Prisma.InputJsonObject;
  await repo.saveIntegrationConfig(userId, config, false);
}

export async function saveOrgCardholderId(userId: string, cardholderId: string): Promise<void> {
  const existing = configRecord(await repo.findTokenConfig(userId));
  delete existing.onboardingSessionId;
  delete existing.onboardingSetupUrl;
  delete existing.onboardingExpiresAt;
  await repo.saveIntegrationConfig(
    userId,
    { ...existing, orgManaged: true, cardholderId } as Prisma.InputJsonObject,
    true
  );
}

export async function clearUserToken(userId: string): Promise<void> {
  await repo.clearToken(userId);
}
