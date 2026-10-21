import { prisma } from './database';
import {
  decryptCredentialEnvelope,
  markPoolTokenRateLimited,
  markUserTokenRateLimited,
} from './claudeCredentials';
import {
  claudeEnvelopeExpiredAt,
  isUsableClaudePoolEnvelope,
  parseClaudeEnvelope,
} from './claudeOauthEnvelope';
import { markGptPoolTokenRateLimited, markGptUserTokenRateLimited } from './gptCredentials';
import { createLogger } from './logger';
export {
  __clearGptApiKeyCooldownCache,
  __resetGptApiKeyCooldown,
  isGptApiKeyOnCooldown,
  markGptApiKeyOnCooldown,
} from './gptCredentials';

const log = createLogger('ComputeCredentials');

export type ComputeCodeCredentialType = 'claude' | 'gpt';

export interface ComputeCodeCredentialResult {
  type: ComputeCodeCredentialType;
  accessToken: string;
  accountId?: string;
  source: 'user' | 'pool';
  userId: string;
  poolTokenId?: string;
  lineageKey?: string;
}

type IntegrationRow = {
  id: string;
  userId: string;
  name: string;
  config: unknown;
};

type ComputeLeaseOptions = {
  lineageKey?: string;
  agentId?: string;
  rootAgentId?: string;
  fastCacheAffinityKey?: string;
  tokenType?: ComputeCodeCredentialType;
};
type RequiredLineageLease = Required<
  Pick<ComputeLeaseOptions, 'lineageKey' | 'agentId' | 'rootAgentId'>
>;

const LINEAGE_LEASE_TTL_MS = 5 * 60 * 1000;
const GPT_LINEAGE_CAPACITY = 16;
const CLAUDE_LINEAGE_CAPACITY = 12;

function capacityForType(type: ComputeCodeCredentialType): number {
  return type === 'gpt' ? GPT_LINEAGE_CAPACITY : CLAUDE_LINEAGE_CAPACITY;
}

function tokenIdentity(
  token: Pick<ComputeCodeCredentialResult, 'source' | 'userId' | 'poolTokenId'>
): string {
  return token.source === 'pool' ? (token.poolTokenId ?? '') : token.userId;
}

function liveLeaseCutoff(now: Date): Date {
  return new Date(now.getTime() - LINEAGE_LEASE_TTL_MS);
}

function normalizeFastCacheAffinityKey(key: string | undefined): string | null {
  const trimmed = key?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function integrationNamesForAffinity(
  tokenType: ComputeCodeCredentialType | null
): Array<'claude_code' | 'gpt_code'> {
  if (tokenType === 'claude') return ['claude_code'];
  if (tokenType === 'gpt') return ['gpt_code'];
  return ['claude_code', 'gpt_code'];
}

function decryptIntegrationCredentials(integration: IntegrationRow, decryptionKey: string) {
  const config = integration.config as Record<string, unknown> | null;
  const encryptedCredentials = config?.encryptedCredentials as string | undefined;
  if (!encryptedCredentials) return null;
  return decryptCredentialEnvelope(encryptedCredentials, decryptionKey);
}

/** Retire exactly this row: EXPIRED + needs-reconnect, never its sibling accounts. */
async function retireExpiredClaudeIntegration(
  integration: IntegrationRow,
  source: 'user' | 'pool',
  expiresAt: number
): Promise<void> {
  log.warn('Skipping Claude credential past its own expiresAt', {
    integrationId: integration.id,
    userId: integration.userId,
    source,
    expiredAt: new Date(expiresAt).toISOString(),
  });
  await markUserTokenRateLimited(integration.userId, {
    failureReason: 'auth_error',
    integrationId: integration.id,
  });
}

function parseGptEnvelope(credentialsJson: string) {
  try {
    const parsed = JSON.parse(credentialsJson) as Record<string, unknown>;
    if (parsed.auth_mode !== 'chatgpt') return null;
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : '';
    // This selector only hands an access token to Rose/SMS workers. Cloud-minted
    // grants intentionally omit the refresh lineage, while legacy synced
    // auth.json envelopes still include it. Requiring refresh_token here made a
    // healthy access-only grant invisible even though this path never uses it.
    // The Codex CLI sandbox reader remains strict in gptCredentials.ts because
    // that surface receives and persists the complete auth.json envelope.
    if (accessToken.length === 0) return null;
    const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id : undefined;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

function typeForIntegration(name: string): ComputeCodeCredentialType | null {
  if (name === 'claude_code') return 'claude';
  if (name === 'gpt_code') return 'gpt';
  return null;
}

async function rowToCredential(
  integration: IntegrationRow,
  decryptionKey: string,
  source: 'user' | 'pool'
): Promise<ComputeCodeCredentialResult | null> {
  const type = typeForIntegration(integration.name);
  if (!type) return null;
  const decrypted = decryptIntegrationCredentials(integration, decryptionKey);
  if (!decrypted) return null;

  if (type === 'claude') {
    const envelope = parseClaudeEnvelope(decrypted);
    if (!envelope) return null;
    const expired = claudeEnvelopeExpiredAt(envelope, Date.now());
    if (expired !== null) {
      await retireExpiredClaudeIntegration(integration, source, expired);
      return null;
    }
    if (source === 'pool' && !isUsableClaudePoolEnvelope(envelope)) return null;
    return {
      type,
      accessToken: envelope.accessToken,
      source,
      userId: integration.userId,
      poolTokenId: source === 'pool' ? integration.id : undefined,
    };
  }

  const parsed = parseGptEnvelope(decrypted);
  if (!parsed) return null;
  return {
    type,
    accessToken: parsed.accessToken,
    accountId: parsed.accountId,
    source,
    userId: integration.userId,
    poolTokenId: source === 'pool' ? integration.id : undefined,
  };
}

async function selectFirstUsable(
  integrations: IntegrationRow[],
  decryptionKey: string,
  source: 'user' | 'pool',
  now: Date
) {
  for (const integration of integrations) {
    const result = await rowToCredential(integration, decryptionKey, source);
    if (!result) continue;
    await prisma.integration.update({ where: { id: integration.id }, data: { lastUsedAt: now } });
    log.info('Serving compute token', {
      type: result.type,
      source,
      userId: integration.userId,
      integrationId: integration.id,
    });
    return result;
  }
  return null;
}

async function fetchCredentialForLease(
  lineageKey: string,
  decryptionKey: string,
  now: Date,
  requiredTokenType: ComputeCodeCredentialType | null = null
): Promise<ComputeCodeCredentialResult | null> {
  const lease = await prisma.computeTokenLineageLease.findUnique({ where: { lineageKey } });
  if (!lease || lease.releasedAt || lease.lastUsedAt <= liveLeaseCutoff(now)) return null;
  if (lease.tokenType !== 'claude' && lease.tokenType !== 'gpt') return null;
  if (requiredTokenType !== null && lease.tokenType !== requiredTokenType) {
    await prisma.computeTokenLineageLease.update({
      where: { lineageKey },
      data: { releasedAt: now },
    });
    return null;
  }
  if (lease.tokenSource !== 'user' && lease.tokenSource !== 'pool') return null;

  const name = lease.tokenType === 'claude' ? 'claude_code' : 'gpt_code';
  const integration = await prisma.integration.findFirst({
    where: {
      name,
      status: 'CONNECTED',
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
      ...(lease.tokenSource === 'pool'
        ? { id: lease.tokenIdentity, poolingEnabled: true }
        : { userId: lease.tokenIdentity }),
    },
  });
  if (!integration) {
    await prisma.computeTokenLineageLease.update({
      where: { lineageKey },
      data: { releasedAt: now },
    });
    return null;
  }

  const result = await rowToCredential(integration, decryptionKey, lease.tokenSource);
  if (!result) {
    await prisma.computeTokenLineageLease.update({
      where: { lineageKey },
      data: { releasedAt: now },
    });
    return null;
  }

  await prisma.$transaction([
    prisma.computeTokenLineageLease.update({
      where: { lineageKey },
      data: { lastUsedAt: now },
    }),
    prisma.integration.update({ where: { id: integration.id }, data: { lastUsedAt: now } }),
  ]);

  return { ...result, lineageKey };
}

async function tryAcquireLineageLease(
  lineage: RequiredLineageLease,
  token: ComputeCodeCredentialResult,
  integrationId: string,
  now: Date
): Promise<ComputeCodeCredentialResult | null> {
  const identity = tokenIdentity(token);
  if (!identity) return null;

  const capacity = capacityForType(token.type);
  const cutoff = liveLeaseCutoff(now);
  const lockKey = `compute-token-lineage:${token.type}:${token.source}:${identity}`;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const existingLease = await tx.computeTokenLineageLease.findUnique({
      where: { lineageKey: lineage.lineageKey },
    });
    if (
      existingLease &&
      !existingLease.releasedAt &&
      existingLease.lastUsedAt > cutoff &&
      existingLease.tokenType === token.type &&
      existingLease.tokenSource === token.source &&
      existingLease.tokenIdentity === identity
    ) {
      await tx.computeTokenLineageLease.update({
        where: { lineageKey: lineage.lineageKey },
        data: { lastUsedAt: now, agentId: lineage.agentId, rootAgentId: lineage.rootAgentId },
      });
      await tx.integration.update({ where: { id: integrationId }, data: { lastUsedAt: now } });
      return { ...token, lineageKey: lineage.lineageKey };
    }

    const liveLeaseCount = await tx.computeTokenLineageLease.count({
      where: {
        tokenType: token.type,
        tokenSource: token.source,
        tokenIdentity: identity,
        releasedAt: null,
        lastUsedAt: { gt: cutoff },
      },
    });
    if (liveLeaseCount >= capacity) return null;

    await tx.computeTokenLineageLease.upsert({
      where: { lineageKey: lineage.lineageKey },
      create: {
        lineageKey: lineage.lineageKey,
        tokenType: token.type,
        tokenSource: token.source,
        tokenIdentity: identity,
        userId: token.source === 'user' ? token.userId : undefined,
        agentId: lineage.agentId,
        rootAgentId: lineage.rootAgentId,
        assignedAt: now,
        lastUsedAt: now,
      },
      update: {
        tokenType: token.type,
        tokenSource: token.source,
        tokenIdentity: identity,
        userId: token.source === 'user' ? token.userId : null,
        agentId: lineage.agentId,
        rootAgentId: lineage.rootAgentId,
        lastUsedAt: now,
        releasedAt: null,
      },
    });
    await tx.integration.update({ where: { id: integrationId }, data: { lastUsedAt: now } });

    log.info('Serving compute token lease', {
      type: token.type,
      source: token.source,
      tokenIdentity: identity,
      lineageKey: lineage.lineageKey,
      liveLeaseCount: liveLeaseCount + 1,
      capacity,
    });

    return { ...token, lineageKey: lineage.lineageKey };
  });
}

async function selectFirstUsableWithLineage(
  integrations: IntegrationRow[],
  decryptionKey: string,
  source: 'user' | 'pool',
  now: Date,
  lineage: RequiredLineageLease
): Promise<ComputeCodeCredentialResult | null> {
  for (const integration of integrations) {
    const result = await rowToCredential(integration, decryptionKey, source);
    if (!result) continue;
    const leased = await tryAcquireLineageLease(lineage, result, integration.id, now);
    if (leased) return leased;
  }
  return null;
}

async function readFastCacheAffinity(
  affinityKey: string | null
): Promise<ComputeCodeCredentialType | null> {
  if (affinityKey === null) return null;
  const row = await prisma.computeTokenFastCacheAffinity.findUnique({ where: { affinityKey } });
  if (row?.tokenType === 'claude' || row?.tokenType === 'gpt') return row.tokenType;
  return null;
}

async function persistOrReadFastCacheAffinity(
  affinityKey: string | null,
  userId: string,
  tokenType: ComputeCodeCredentialType
): Promise<ComputeCodeCredentialType> {
  if (affinityKey === null) return tokenType;
  try {
    await prisma.computeTokenFastCacheAffinity.createMany({
      data: { affinityKey, userId, tokenType },
      skipDuplicates: true,
    });
  } catch (error) {
    log.error('Unexpected error persisting fast-cache affinity', { affinityKey, error });
  }
  const existing = await readFastCacheAffinity(affinityKey);
  return existing ?? tokenType;
}

export async function fetchComputeUserToken(
  userId: string,
  tokenType: ComputeCodeCredentialType | null = null
): Promise<ComputeCodeCredentialResult | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) return null;

  const now = new Date();
  const integrations = await prisma.integration.findMany({
    where: {
      userId,
      name: { in: integrationNamesForAffinity(tokenType) },
      status: 'CONNECTED',
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
    },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
  });
  return selectFirstUsable(integrations, decryptionKey, 'user', now);
}

export async function fetchComputePoolToken(
  excludeIds?: string[],
  tokenType: ComputeCodeCredentialType | null = null
): Promise<ComputeCodeCredentialResult | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) return null;

  const now = new Date();
  const integrations = await prisma.integration.findMany({
    where: {
      name: { in: integrationNamesForAffinity(tokenType) },
      status: 'CONNECTED',
      poolingEnabled: true,
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
      ...(excludeIds?.length ? { id: { notIn: excludeIds } } : {}),
    },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
  });
  return selectFirstUsable(integrations, decryptionKey, 'pool', now);
}

export async function fetchComputeTokenForUser(
  userId: string,
  options?: { forcePool?: boolean; excludePoolTokenIds?: string[] } & ComputeLeaseOptions
): Promise<ComputeCodeCredentialResult | null> {
  const fastCacheAffinityKey = normalizeFastCacheAffinityKey(options?.fastCacheAffinityKey);
  const requestedTokenType = options?.tokenType ?? null;
  const pinnedTokenType = requestedTokenType ?? (await readFastCacheAffinity(fastCacheAffinityKey));
  const lineage =
    options?.lineageKey && options.lineageKey.trim() !== ''
      ? {
          lineageKey: options.lineageKey.trim(),
          agentId: options.agentId ?? '',
          rootAgentId: options.rootAgentId ?? options.agentId ?? '',
        }
      : null;
  if (lineage) {
    const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
    if (!decryptionKey) return null;
    const now = new Date();
    const existing = await fetchCredentialForLease(
      lineage.lineageKey,
      decryptionKey,
      now,
      pinnedTokenType
    );
    if (existing) return existing;

    if (options?.forcePool !== true) {
      const userIntegrations = await prisma.integration.findMany({
        where: {
          userId,
          name: { in: integrationNamesForAffinity(pinnedTokenType) },
          status: 'CONNECTED',
          OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
        },
        orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      });
      const userToken = await selectFirstUsableWithLineage(
        userIntegrations,
        decryptionKey,
        'user',
        now,
        lineage
      );
      if (userToken) {
        if (requestedTokenType !== null) return userToken;
        const affinityType = await persistOrReadFastCacheAffinity(
          fastCacheAffinityKey,
          userId,
          userToken.type
        );
        if (affinityType === userToken.type) return userToken;
        await releaseComputeTokenLineage(lineage.lineageKey);
        return fetchComputeTokenForUser(userId, {
          ...options,
          fastCacheAffinityKey: fastCacheAffinityKey ?? undefined,
        });
      }
    }

    const poolIntegrations = await prisma.integration.findMany({
      where: {
        name: { in: integrationNamesForAffinity(pinnedTokenType) },
        status: 'CONNECTED',
        poolingEnabled: true,
        OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
        ...(options?.excludePoolTokenIds?.length
          ? { id: { notIn: options.excludePoolTokenIds } }
          : {}),
      },
      orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    });
    const poolToken = await selectFirstUsableWithLineage(
      poolIntegrations,
      decryptionKey,
      'pool',
      now,
      lineage
    );
    if (!poolToken) return null;
    if (requestedTokenType !== null) return poolToken;
    const affinityType = await persistOrReadFastCacheAffinity(
      fastCacheAffinityKey,
      userId,
      poolToken.type
    );
    if (affinityType === poolToken.type) return poolToken;
    await releaseComputeTokenLineage(lineage.lineageKey);
    return fetchComputeTokenForUser(userId, {
      ...options,
      fastCacheAffinityKey: fastCacheAffinityKey ?? undefined,
    });
  }

  if (options?.forcePool !== true) {
    const userToken = await fetchComputeUserToken(userId, pinnedTokenType);
    if (userToken) return userToken;
  }
  const poolToken = await fetchComputePoolToken(options?.excludePoolTokenIds, pinnedTokenType);
  return poolToken;
}

export async function heartbeatComputeTokenLineage(lineageKey: string) {
  const trimmed = lineageKey.trim();
  if (trimmed === '') return { ok: false, updated: 0 };
  const result = await prisma.computeTokenLineageLease.updateMany({
    where: { lineageKey: trimmed, releasedAt: null },
    data: { lastUsedAt: new Date() },
  });
  return { ok: result.count > 0, updated: result.count };
}

export async function releaseComputeTokenLineage(lineageKey: string) {
  const trimmed = lineageKey.trim();
  if (trimmed === '') return { ok: false, updated: 0 };
  const result = await prisma.computeTokenLineageLease.updateMany({
    where: { lineageKey: trimmed, releasedAt: null },
    data: { releasedAt: new Date() },
  });
  return { ok: result.count > 0, updated: result.count };
}

/**
 * Back a compute token off after a failure.
 *
 * `rateLimitedUntil` is the PROVIDER's own reset time (from
 * `anthropic-ratelimit-*-reset` / `retry-after` / the error body). Pass it
 * whenever the provider supplied one: omitting it makes the cooldown fall back
 * to a synthetic 5-minute default, which is exactly how a real usage window got
 * destroyed in prod on 2026-07-28 — a header-derived `2026-07-30T22:00Z` was
 * overwritten 15s later by an uninformed `+5m` from this path. The synthetic
 * default is only correct when the provider genuinely told us nothing.
 */
export async function markComputeTokenUnavailable(
  token: ComputeCodeCredentialResult,
  reason: 'auth_error' | 'rate_limit',
  rateLimitedUntil?: string
): Promise<void> {
  const failureReason = reason === 'auth_error' ? 'auth_error' : undefined;
  const options = { failureReason, rateLimitedUntil };

  if (token.source === 'pool') {
    if (!token.poolTokenId) {
      log.warn('Cannot mark pool compute token unavailable without poolTokenId', {
        type: token.type,
        reason,
        userId: token.userId,
      });
      return;
    }
    if (token.type === 'claude') {
      await markPoolTokenRateLimited(token.poolTokenId, options);
      return;
    }
    await markGptPoolTokenRateLimited(token.poolTokenId, options);
    return;
  }

  // Pool branch returned above; remaining tokens are user-owned.
  if (token.type === 'claude') {
    await markUserTokenRateLimited(token.userId, {
      ...options,
      accountId: token.accountId,
    });
    return;
  }
  await markGptUserTokenRateLimited(token.userId, {
    ...options,
    accountId: token.accountId,
  });
}

// ── Shared Anthropic API-key cooldown ──────────────────────────────────────
//
// The funded ANTHROPIC_API_KEY (a global default for any user) is a single
// credential. When it reports out-of-credits (402) or bad-key (401/403) there
// is no point any agent on any Temporal workflow retrying it until it recovers.
// We persist a cooldown in the DB — reusing the same `Integration.rateLimitedUntil`
// column the OAuth pool tokens use — so every backend instance AND every Fly
// worker shares one backoff instead of each independently hammering the key.
//
// A tiny in-memory write-through cache keeps the LLM hot path off the DB: the
// row is re-read at most once per recheck interval, cooled or clear, so a
// cooldown cleared in the DB is honored by every instance within that interval.
const ANTHROPIC_API_KEY_COOLDOWN_MS = 30 * 60 * 1000; // 30 min (out-of-credits)
const ANTHROPIC_API_KEY_COOLDOWN_DB_RECHECK_MS = 15 * 1000;
// Sentinel singleton row. userId has no FK; name is outside the served
// ['claude_code','gpt_code'] set, so this row is never handed out as a token.
const ANTHROPIC_API_KEY_COOLDOWN_USER_ID = '00000000-0000-0000-0000-000000000000';
const ANTHROPIC_API_KEY_COOLDOWN_NAME = 'anthropic_api_key_cooldown';

let cachedCooldownUntilMs = 0;
let lastCooldownDbCheckMs = 0;
let cooldownCacheRevision = 0;

/** True when the shared Anthropic API key is currently backed off. */
export async function isAnthropicApiKeyOnCooldown(): Promise<boolean> {
  const now = Date.now();
  if (now - lastCooldownDbCheckMs < ANTHROPIC_API_KEY_COOLDOWN_DB_RECHECK_MS) {
    return now < cachedCooldownUntilMs;
  }
  lastCooldownDbCheckMs = now;
  const cacheRevision = cooldownCacheRevision;
  const row = await prisma.integration.findUnique({
    where: {
      userId_name_accountId: {
        userId: ANTHROPIC_API_KEY_COOLDOWN_USER_ID,
        name: ANTHROPIC_API_KEY_COOLDOWN_NAME,
        accountId: '',
      },
    },
    select: { rateLimitedUntil: true },
  });
  if (cacheRevision !== cooldownCacheRevision) {
    return Date.now() < cachedCooldownUntilMs;
  }
  cachedCooldownUntilMs = row?.rateLimitedUntil ? row.rateLimitedUntil.getTime() : 0;
  return Date.now() < cachedCooldownUntilMs;
}

/** Back the shared Anthropic API key off for the cooldown window (DB + cache). */
export async function markAnthropicApiKeyOnCooldown(reason: string): Promise<void> {
  const until = new Date(Date.now() + ANTHROPIC_API_KEY_COOLDOWN_MS);
  cooldownCacheRevision++;
  cachedCooldownUntilMs = until.getTime();
  // A read issued before the upsert below commits would drop this mark.
  lastCooldownDbCheckMs = Date.now();
  await prisma.integration.upsert({
    where: {
      userId_name_accountId: {
        userId: ANTHROPIC_API_KEY_COOLDOWN_USER_ID,
        name: ANTHROPIC_API_KEY_COOLDOWN_NAME,
        accountId: '',
      },
    },
    create: {
      userId: ANTHROPIC_API_KEY_COOLDOWN_USER_ID,
      name: ANTHROPIC_API_KEY_COOLDOWN_NAME,
      type: 'TOOL_SETUP',
      status: 'NOT_CONNECTED',
      rateLimitedUntil: until,
      failureReason: reason,
    },
    update: { rateLimitedUntil: until, failureReason: reason },
  });
  log.warn('Anthropic API key backed off', { reason, until: until.toISOString() });
}

/** Test-only: clear both the in-memory cache and the DB cooldown row. */
export async function __resetAnthropicApiKeyCooldown(): Promise<void> {
  cooldownCacheRevision++;
  cachedCooldownUntilMs = 0;
  lastCooldownDbCheckMs = 0;
  await prisma.integration.deleteMany({
    where: {
      userId: ANTHROPIC_API_KEY_COOLDOWN_USER_ID,
      name: ANTHROPIC_API_KEY_COOLDOWN_NAME,
    },
  });
}

export { getCerebrasApiKeyCooldown, markCerebrasApiKeyOnCooldown } from './cerebrasApiKeyCooldown';
