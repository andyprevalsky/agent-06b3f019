import { prisma } from './database';
import { decryptCredentialEnvelope } from './claudeCredentials';
import {
  claudeEnvelopeExpiredAt,
  isUsableClaudePoolEnvelope,
  parseClaudeEnvelope,
} from './claudeOauthEnvelope';
import { createLogger } from './logger';
import { recordSubscriptionUsage, type SubscriptionUsageReport } from './computeSubscriptionUsage';
import { rememberSubscriptionCredential } from './rose/subscriptionUsage';
import { teamComputeIntegrations as teamIntegrations } from './computeTeamShares';
export { teamComputeOwner } from './computeTeamShares';
export { classifyReportedLogin, markComputeTokenUnavailable } from './computeLoginFailure';
import { resolveUserLoginByCredential } from './computeLoginFailure';
export {
  __clearGptApiKeyCooldownCache,
  __resetGptApiKeyCooldown,
  isGptApiKeyOnCooldown,
  markGptApiKeyOnCooldown,
} from './gptCredentials';

const log = createLogger('ComputeCredentials');

export type ComputeCodeCredentialType = 'claude' | 'gpt';

/**
 * Where a served compute token comes from, in lease order:
 *   user  the caller's own subscription
 *   team  a teammate's subscription shared with one of the caller's teams
 *         (docs/plans/active/share-all-integrations.md); `userId` is its owner
 *   pool  a pooled subscription
 */
export type ComputeTokenSource = 'user' | 'team' | 'pool';

export interface ComputeCodeCredentialResult {
  type: ComputeCodeCredentialType;
  accessToken: string;
  accountId?: string;
  source: ComputeTokenSource;
  /** The token's owner: the caller for `user`, the sharing teammate for `team`. */
  userId: string;
  /** Set for `team`: the team the owner shared this compute account with. */
  teamId?: string;
  poolTokenId?: string;
  /** The exact Integration row served; failure reports name it (S33). */
  integrationId?: string;
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
  /**
   * Lease a teammate's shared subscription after the caller's own (default
   * true). Only server-side Rose completions may hold one: no sandbox or Mac
   * credential path reads this module, and the HTTP route passes false for any
   * caller that is not the internal agents service.
   */
  includeTeam?: boolean;
};
type RequiredLineageLease = Required<
  Pick<ComputeLeaseOptions, 'lineageKey' | 'agentId' | 'rootAgentId'>
>;

const LINEAGE_LEASE_TTL_MS = 5 * 60 * 1000;
export const GPT_LINEAGE_CAPACITY = 16;
const CLAUDE_LINEAGE_CAPACITY = 12;

function capacityForType(type: ComputeCodeCredentialType): number {
  return type === 'gpt' ? GPT_LINEAGE_CAPACITY : CLAUDE_LINEAGE_CAPACITY;
}

/** Lease capacity key: the pool row, the shared row (team leases are keyed by integration), or the user. */
function tokenIdentity(
  token: Pick<ComputeCodeCredentialResult, 'source' | 'userId' | 'poolTokenId' | 'integrationId'>
): string {
  if (token.source === 'pool') return token.poolTokenId ?? '';
  if (token.source === 'team') return token.integrationId ?? '';
  return token.userId;
}

function liveLeaseCutoff(now: Date): Date {
  return new Date(now.getTime() - LINEAGE_LEASE_TTL_MS);
}

function normalizeDemoCacheAffinityKey(key: string | undefined): string | null {
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
    // The Codex CLI sandbox reader in gptCredentials.ts likewise serves the
    // access token only and strips any refresh token before it leaves the server.
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
  integration: IntegrationRow & { teamId?: string },
  decryptionKey: string,
  source: ComputeTokenSource
): Promise<ComputeCodeCredentialResult | null> {
  const team = source === 'team' ? { teamId: integration.teamId } : {};
  const type = typeForIntegration(integration.name);
  if (!type) return null;
  const decrypted = decryptIntegrationCredentials(integration, decryptionKey);
  if (!decrypted) return null;

  if (type === 'claude') {
    const envelope = parseClaudeEnvelope(decrypted);
    if (!envelope) return null;
    const expired = claudeEnvelopeExpiredAt(envelope, Date.now());
    if (expired !== null) {
      // An expired access token is not a revoked login: its device's next sync
      // replaces it (codeLoginRejection.ts), so it is skipped, never disabled.
      // Stamping it moves it behind every live row in least-recently-used order,
      // so each lease does not decrypt it first again.
      await prisma.integration.update({
        where: { id: integration.id },
        data: { lastUsedAt: new Date() },
      });
      log.info('Skipping Claude credential past its own expiresAt', {
        integrationId: integration.id,
        userId: integration.userId,
        source,
        expiredAt: new Date(expired).toISOString(),
      });
      return null;
    }
    if (source === 'pool' && !isUsableClaudePoolEnvelope(envelope)) return null;
    return {
      type,
      accessToken: envelope.accessToken,
      source,
      userId: integration.userId,
      poolTokenId: source === 'pool' ? integration.id : undefined,
      integrationId: integration.id,
      ...team,
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
    integrationId: integration.id,
    ...team,
  };
}

async function selectFirstUsable(
  integrations: IntegrationRow[],
  decryptionKey: string,
  source: ComputeTokenSource,
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

async function leasedIntegration(
  lease: { tokenType: string; tokenSource: string; tokenIdentity: string },
  userId: string,
  now: Date
): Promise<(IntegrationRow & { teamId?: string }) | null> {
  const name = lease.tokenType === 'claude' ? 'claude_code' : 'gpt_code';
  if (lease.tokenSource === 'team') {
    // Revalidated on every reuse: unshare, disconnect or leaving the team ends it at once.
    const [row] = await teamIntegrations(
      userId,
      lease.tokenType as ComputeCodeCredentialType,
      now,
      lease.tokenIdentity
    );
    return row ?? null;
  }
  return prisma.integration.findFirst({
    where: {
      name,
      status: 'CONNECTED',
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
      ...(lease.tokenSource === 'pool'
        ? { id: lease.tokenIdentity, poolingEnabled: true }
        : { userId: lease.tokenIdentity }),
    },
  });
}

async function fetchCredentialForLease(
  lineageKey: string,
  userId: string,
  decryptionKey: string,
  now: Date,
  requiredTokenType: ComputeCodeCredentialType | null = null,
  includeTeam = true
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
  if (
    lease.tokenSource !== 'user' &&
    lease.tokenSource !== 'pool' &&
    (lease.tokenSource !== 'team' || !includeTeam)
  )
    return null;
  const tokenSource: ComputeTokenSource = lease.tokenSource;

  const integration = await leasedIntegration(lease, userId, now);
  if (!integration) {
    await prisma.computeTokenLineageLease.update({
      where: { lineageKey },
      data: { releasedAt: now },
    });
    return null;
  }

  const result = await rowToCredential(integration, decryptionKey, tokenSource);
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
  integrations: Array<IntegrationRow & { teamId?: string }>,
  decryptionKey: string,
  source: ComputeTokenSource,
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

async function readDemoCacheAffinity(
  affinityKey: string | null
): Promise<ComputeCodeCredentialType | null> {
  if (affinityKey === null) return null;
  const row = await prisma.computeTokenFastCacheAffinity.findUnique({ where: { affinityKey } });
  if (row?.tokenType === 'claude' || row?.tokenType === 'gpt') return row.tokenType;
  return null;
}

async function persistOrReadDemoCacheAffinity(
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
    log.error('Unexpected error persisting demo-cache affinity', { affinityKey, error });
  }
  const existing = await readDemoCacheAffinity(affinityKey);
  return existing ?? tokenType;
}

/**
 * The live Claude access token of one claude_code row, and whether its grant
 * carries `user:profile` (the usage endpoint's scope; setup-tokens are
 * `user:inference` only), for a read-only usage lookup (computeUsageRefresh).
 * No side effects: it does not stamp lastUsedAt, lease, or touch the row's
 * state; an expired or undecryptable token is null.
 */
export async function readClaudeUsageCredential(
  integrationId: string
): Promise<{ accessToken: string; profileScope: boolean } | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) return null;
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, name: 'claude_code', status: 'CONNECTED' },
  });
  if (!integration) return null;
  const decrypted = decryptIntegrationCredentials(integration, decryptionKey);
  const envelope = decrypted ? parseClaudeEnvelope(decrypted) : null;
  if (!envelope || claudeEnvelopeExpiredAt(envelope, Date.now()) !== null) return null;
  return { accessToken: envelope.accessToken, profileScope: envelope.profileScope };
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

/** A teammate's shared subscription (no lineage); server-side Rose completions only. */
export async function fetchComputeTeamToken(
  userId: string,
  tokenType: ComputeCodeCredentialType | null = null
): Promise<ComputeCodeCredentialResult | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) return null;
  const now = new Date();
  const integrations = await teamIntegrations(userId, tokenType, now);
  return selectFirstUsable(integrations, decryptionKey, 'team', now);
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

type ComputeTokenForUserOptions = {
  forcePool?: boolean;
  excludePoolTokenIds?: string[];
} & ComputeLeaseOptions;

/**
 * Lease a compute token for a user: own → team-shared → pool (the Rose
 * waterfall's funded keys follow when this returns null). The served row is
 * remembered (by token fingerprint) so this process's own Rose completions on
 * it record the account's usage onto that row (rose/subscriptionUsage.ts).
 * Server-side Rose LLM calls only: never hand a result to a sandbox or Mac.
 */
export async function fetchComputeTokenForUser(
  userId: string,
  options?: ComputeTokenForUserOptions
): Promise<ComputeCodeCredentialResult | null> {
  const token = await leaseComputeTokenForUser(userId, options);
  if (token !== null) rememberSubscriptionCredential(token);
  return token;
}

async function leaseComputeTokenForUser(
  userId: string,
  options?: ComputeTokenForUserOptions
): Promise<ComputeCodeCredentialResult | null> {
  const fastCacheAffinityKey = normalizeDemoCacheAffinityKey(options?.fastCacheAffinityKey);
  const requestedTokenType = options?.tokenType ?? null;
  const pinnedTokenType = requestedTokenType ?? (await readDemoCacheAffinity(fastCacheAffinityKey));
  const includeTeam = options?.includeTeam !== false;
  const ownFirst = options?.forcePool !== true;
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
      userId,
      decryptionKey,
      now,
      pinnedTokenType,
      includeTeam
    );
    if (existing) return existing;

    // A served token pins the demo-cache affinity; a conflicting pin re-leases on it.
    const settle = async (token: ComputeCodeCredentialResult) => {
      if (requestedTokenType !== null) return token;
      const affinityType = await persistOrReadDemoCacheAffinity(
        fastCacheAffinityKey,
        userId,
        token.type
      );
      if (affinityType === token.type) return token;
      await releaseComputeTokenLineage(lineage.lineageKey);
      return fetchComputeTokenForUser(userId, {
        ...options,
        fastCacheAffinityKey: fastCacheAffinityKey ?? undefined,
      });
    };

    if (ownFirst) {
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
      if (userToken) return settle(userToken);
      if (includeTeam) {
        const teamToken = await selectFirstUsableWithLineage(
          await teamIntegrations(userId, pinnedTokenType, now),
          decryptionKey,
          'team',
          now,
          lineage
        );
        if (teamToken) return settle(teamToken);
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
    return poolToken ? settle(poolToken) : null;
  }

  if (ownFirst) {
    const userToken = await fetchComputeUserToken(userId, pinnedTokenType);
    if (userToken) return userToken;
    const teamToken = includeTeam ? await fetchComputeTeamToken(userId, pinnedTokenType) : null;
    if (teamToken) return teamToken;
  }
  const poolToken = await fetchComputePoolToken(options?.excludePoolTokenIds, pinnedTokenType);
  return poolToken;
}

/**
 * Keep a lineage lease live. The heartbeat may also carry the subscription
 * usage snapshot the worker last observed for this token (flushed right after
 * each response, success or failure); it is recorded while the lease is live or
 * was released within USAGE_RELEASED_LEASE_GRACE_MS (the flush of an agent's
 * last response races its release), riding this existing per-call request.
 */
export async function heartbeatComputeTokenLineage(
  lineageKey: string,
  usage: SubscriptionUsageReport | null = null
) {
  const trimmed = lineageKey.trim();
  if (trimmed === '') return { ok: false, updated: 0, usageRecorded: false };
  const result = await prisma.computeTokenLineageLease.updateMany({
    where: { lineageKey: trimmed, releasedAt: null },
    data: { lastUsedAt: new Date() },
  });
  const usageRecorded =
    usage !== null
      ? await recordSubscriptionUsage(trimmed, usage, new Date(), resolveUserLoginByCredential)
      : false;
  return { ok: result.count > 0, updated: result.count, usageRecorded };
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

export {
  __resetAnthropicApiKeyCooldown,
  anthropicApiKeyCooldownUntil,
  isAnthropicApiKeyOnCooldown,
  markAnthropicApiKeyOnCooldown,
} from './anthropicApiKeyCooldown';
export { getCerebrasApiKeyCooldown, markCerebrasApiKeyOnCooldown } from './cerebrasApiKeyCooldown';
