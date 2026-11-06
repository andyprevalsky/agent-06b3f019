import {
  isIntegrationAuthFailureReason,
  markConnectionNeedsReconnectFromIntegrationFailure,
  syncConnectionAfterIntegrationAuthFailure,
} from './integrationConnectionSync';
import type { StoredLogin } from './codeLoginRejection';
import { prisma } from './database';
import { decryptCredentialEnvelope } from './claudeCredentials';
import { createLogger } from './logger';

const log = createLogger('GptCredentials');
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const GPT_API_KEY_COOLDOWN_MS = 30 * 60 * 1000;
const GPT_API_KEY_COOLDOWN_USER_ID = '00000000-0000-0000-0000-000000000000';
const GPT_API_KEY_COOLDOWN_NAME = 'gpt_api_key_cooldown';
const GPT_API_KEY_COOLDOWN_DB_RECHECK_MS = 15 * 1000;
let cachedGptKeyCooldownUntilMs = 0;
let lastGptKeyCooldownDbCheckMs = 0;
let gptKeyCooldownCacheRevision = 0;
let pendingGptKeyCooldownWrites = 0;

/** Test-only: refresh the local cache without changing the persisted cooldown. */
export function __clearGptApiKeyCooldownCache(): void {
  gptKeyCooldownCacheRevision++;
  cachedGptKeyCooldownUntilMs = 0;
  lastGptKeyCooldownDbCheckMs = 0;
}

export interface GptCodeCredentialResult {
  accessToken: string;
  accountId?: string;
  source: 'user' | 'pool';
  userId: string;
  integrationId?: string;
  poolTokenId?: string;
}

export interface GptCodeCredentialEnvelopeResult extends GptCodeCredentialResult {
  credentials: string;
}

function decryptIntegrationCredentials(
  integration: { id: string; config: unknown },
  decryptionKey: string
): string | null {
  const config = integration.config as Record<string, unknown> | null;
  const encryptedCredentials = config?.encryptedCredentials as string | undefined;
  if (!encryptedCredentials) return null;
  return decryptCredentialEnvelope(encryptedCredentials, decryptionKey);
}

function parseGptCodeEnvelope(credentialsJson: string) {
  try {
    const parsed = JSON.parse(credentialsJson) as Record<string, unknown>;
    if (parsed.auth_mode !== 'chatgpt') return null;
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : '';
    // Access-only grants (cloud-minted, or already sandbox-shaped) are valid:
    // no consumer of this envelope may refresh it.
    if (accessToken.length === 0) return null;
    const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id : undefined;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

/** Codex refreshes an access token this close to its JWT `exp` (manager.rs). */
const CODEX_ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Access-token expiry from the ChatGPT JWT `exp` claim: a number of epoch ms,
 * `null` when the token is not a JWT or carries no `exp` (Codex then falls back
 * to `last_refresh`), or `'malformed'` for a non-numeric `exp`.
 */
function codexAccessTokenExpiry(accessToken: string): number | null | 'malformed' {
  const payload = accessToken.split('.')[1];
  if (accessToken.split('.').length !== 3 || !payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (claims.exp === undefined) return null;
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp)
      ? claims.exp * 1000
      : 'malformed';
  } catch {
    return null;
  }
}

/**
 * The auth.json a Codex CLI sandbox or local device receives: the access token
 * only, never the refresh token.
 *
 * A `gpt_code` Integration is a copy of a grant the user's own Codex CLI
 * (`~/.codex/auth.json`) still holds. OpenAI rotates the refresh token on every
 * refresh, so a sandbox that refreshed it signed the user's own Codex out
 * (`refresh_token_reused` / `refresh_token_invalidated`) and rotated the grant
 * under every concurrent sandbox. The owning device refreshes and re-uploads;
 * the server and its sandboxes never do. An access token inside Codex's 5-minute
 * refresh window (or with a malformed `exp`) is not served at all, so selection
 * falls through to the pool or the funded key instead of a doomed refresh.
 */
function toSandboxCodexAuthJson(credentialsJson: string): string | null {
  if (!parseGptCodeEnvelope(credentialsJson)) return null;
  const parsed = JSON.parse(credentialsJson) as Record<string, unknown>;
  const tokens = parsed.tokens as Record<string, unknown>;
  const expiresAt = codexAccessTokenExpiry(tokens.access_token as string);
  if (
    expiresAt === 'malformed' ||
    (expiresAt !== null && expiresAt <= Date.now() + CODEX_ACCESS_TOKEN_REFRESH_WINDOW_MS)
  ) {
    return null;
  }
  // `last_refresh` only drives Codex's refresh schedule for a token without a
  // JWT `exp`; stamping the serve time keeps the CLI from attempting a refresh
  // that cannot succeed and would read as a revoked grant (oauth_refresh_invalid).
  return JSON.stringify({
    ...parsed,
    tokens: { ...tokens, refresh_token: '' },
    last_refresh: new Date().toISOString(),
  });
}

function resolveRateLimitedUntil(rateLimitedUntil?: string | Date | null): Date {
  if (rateLimitedUntil instanceof Date) return rateLimitedUntil;
  if (typeof rateLimitedUntil === 'string') {
    const parsed = new Date(rateLimitedUntil);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() + RATE_LIMIT_COOLDOWN_MS);
}

/**
 * Only ever EXTEND a backoff window — never shorten one. Mirrors the identical
 * guard in `claudeCredentials.ts`; see the comment there for the prod incident
 * that motivated it (a generic short cooldown clobbering a provider-supplied
 * multi-day reset, which then re-served an exhausted token every few minutes).
 */
function notAlreadyBackedOffLonger(until: Date) {
  return {
    OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: until } }],
  };
}

export async function fetchGptPoolToken(
  excludeIds?: string[]
): Promise<GptCodeCredentialResult | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) return null;

  const now = new Date();
  const poolIntegrations = await prisma.integration.findMany({
    where: {
      name: 'gpt_code',
      status: 'CONNECTED',
      poolingEnabled: true,
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
      ...(excludeIds?.length ? { id: { notIn: excludeIds } } : {}),
    },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }],
  });

  for (const poolIntegration of poolIntegrations) {
    const decrypted = decryptIntegrationCredentials(poolIntegration, decryptionKey);
    const parsed = decrypted ? parseGptCodeEnvelope(decrypted) : null;
    if (!parsed) continue;

    await prisma.integration.update({
      where: { id: poolIntegration.id },
      data: { lastUsedAt: now },
    });
    log.info('Serving GPT pool token', {
      integrationId: poolIntegration.id,
      userId: poolIntegration.userId,
    });
    return {
      accessToken: parsed.accessToken,
      accountId: parsed.accountId,
      source: 'pool',
      userId: poolIntegration.userId,
      integrationId: poolIntegration.id,
      poolTokenId: poolIntegration.id,
    };
  }

  return null;
}

export async function fetchGptCodeCredentialsWithMeta(
  userId: string
): Promise<GptCodeCredentialEnvelopeResult | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) return null;

  const now = new Date();
  // First servable login wins: an expired least-recently-used row must not hide
  // a live sibling account (availability uses the same rule).
  const userIntegrations = await prisma.integration.findMany({
    where: {
      userId,
      name: 'gpt_code',
      status: 'CONNECTED',
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
    },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
  });

  for (const userIntegration of userIntegrations) {
    const decrypted = decryptIntegrationCredentials(userIntegration, decryptionKey);
    const parsed = decrypted ? parseGptCodeEnvelope(decrypted) : null;
    const sandboxAuthJson = decrypted ? toSandboxCodexAuthJson(decrypted) : null;
    if (parsed && sandboxAuthJson) {
      await prisma.integration.update({
        where: { id: userIntegration.id },
        data: { lastUsedAt: now },
      });
      log.info('Serving user GPT Code credentials', {
        userId,
        integrationId: userIntegration.id,
      });
      return {
        credentials: sandboxAuthJson,
        accessToken: parsed.accessToken,
        accountId: parsed.accountId,
        source: 'user',
        userId,
        integrationId: userIntegration.id,
      };
    }
  }

  const poolIntegrations = await prisma.integration.findMany({
    where: {
      name: 'gpt_code',
      status: 'CONNECTED',
      poolingEnabled: true,
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
    },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
  });

  for (const poolIntegration of poolIntegrations) {
    const decrypted = decryptIntegrationCredentials(poolIntegration, decryptionKey);
    const parsed = decrypted ? parseGptCodeEnvelope(decrypted) : null;
    const sandboxAuthJson = decrypted ? toSandboxCodexAuthJson(decrypted) : null;
    if (!parsed || !sandboxAuthJson) continue;

    await prisma.integration.update({
      where: { id: poolIntegration.id },
      data: { lastUsedAt: now },
    });
    log.info('Serving pool GPT Code credentials', {
      integrationId: poolIntegration.id,
      userId: poolIntegration.userId,
    });
    return {
      credentials: sandboxAuthJson,
      accessToken: parsed.accessToken,
      accountId: parsed.accountId,
      source: 'pool',
      userId: poolIntegration.userId,
      integrationId: poolIntegration.id,
      poolTokenId: poolIntegration.id,
    };
  }

  return null;
}

export async function markGptPoolTokenRateLimited(
  poolTokenId: string,
  options?: { rateLimitedUntil?: string | Date | null; failureReason?: string | null }
): Promise<void> {
  if (isIntegrationAuthFailureReason(options?.failureReason)) {
    await prisma.integration.update({
      where: { id: poolTokenId },
      data: {
        poolingEnabled: false,
        rateLimitedUntil: null,
        failureReason: options.failureReason,
      },
    });
    log.info(`GPT pool token ${poolTokenId} disabled after ${options.failureReason}`);
    await syncConnectionAfterIntegrationAuthFailure({
      integrationId: poolTokenId,
      failureReason: options.failureReason,
    });
    return;
  }

  const until = resolveRateLimitedUntil(options?.rateLimitedUntil);
  const { count } = await prisma.integration.updateMany({
    where: { id: poolTokenId, ...notAlreadyBackedOffLonger(until) },
    data: { rateLimitedUntil: until },
  });
  if (count === 0) {
    // No match means EITHER an existing longer window (benign) OR a stale id the
    // previous single-record `update` would have thrown on. Disambiguate.
    const existing = await prisma.integration.findUnique({
      where: { id: poolTokenId },
      select: { id: true },
    });
    if (existing === null) {
      log.warn(
        `GPT pool token ${poolTokenId} not found; cannot rate-limit (stale integration id?)`
      );
      return;
    }
    log.info(
      `GPT pool token ${poolTokenId} already backed off past ${until.toISOString()} — keeping the longer window`
    );
    return;
  }
  log.info(`GPT pool token ${poolTokenId} rate-limited until ${until.toISOString()}`);
}

export async function markGptIntegrationRateLimited(
  integrationId: string,
  options?: { rateLimitedUntil?: string | Date | null }
): Promise<void> {
  const until = resolveRateLimitedUntil(options?.rateLimitedUntil);
  const { count } = await prisma.integration.updateMany({
    where: { id: integrationId, ...notAlreadyBackedOffLonger(until) },
    data: { rateLimitedUntil: until },
  });
  if (count === 0) {
    const existing = await prisma.integration.findUnique({
      where: { id: integrationId },
      select: { id: true },
    });
    if (existing === null) {
      log.warn(`GPT integration ${integrationId} not found; cannot rate-limit (stale id?)`);
      return;
    }
    log.info(
      `GPT integration ${integrationId} already backed off past ${until.toISOString()} — keeping the longer window`
    );
    return;
  }
  log.info(`GPT integration ${integrationId} rate-limited until ${until.toISOString()}`);
}

/**
 * True when the shared funded GPT_API_KEY is currently backed off. The shared
 * row is re-read at most once per recheck interval in both states, so a
 * cooldown cleared in the DB is honored by every instance within that interval.
 */
export async function isGptApiKeyOnCooldown(): Promise<boolean> {
  const now = Date.now();
  // A local mark must remain effective while its DB upsert is in flight.
  // The prior row can still be absent when a concurrent recheck starts.
  if (pendingGptKeyCooldownWrites > 0 && now < cachedGptKeyCooldownUntilMs) return true;
  // The DB is authoritative. A test fixture or operator can remove a cooldown
  // while this process is alive, so even a positive cache needs rechecking.
  if (now - lastGptKeyCooldownDbCheckMs < GPT_API_KEY_COOLDOWN_DB_RECHECK_MS) {
    return now < cachedGptKeyCooldownUntilMs;
  }
  lastGptKeyCooldownDbCheckMs = now;
  const cacheRevision = gptKeyCooldownCacheRevision;
  const row = await prisma.integration.findUnique({
    where: {
      userId_name_accountId: {
        userId: GPT_API_KEY_COOLDOWN_USER_ID,
        name: GPT_API_KEY_COOLDOWN_NAME,
        accountId: '',
      },
    },
    select: { rateLimitedUntil: true },
  });
  if (cacheRevision !== gptKeyCooldownCacheRevision) {
    return Date.now() < cachedGptKeyCooldownUntilMs;
  }
  cachedGptKeyCooldownUntilMs = row?.rateLimitedUntil?.getTime() ?? 0;
  return Date.now() < cachedGptKeyCooldownUntilMs;
}

/** Back the shared funded GPT_API_KEY off after a provider quota response. */
export async function markGptApiKeyOnCooldown(reason: string): Promise<void> {
  const until = new Date(Date.now() + GPT_API_KEY_COOLDOWN_MS);
  gptKeyCooldownCacheRevision++;
  cachedGptKeyCooldownUntilMs = until.getTime();
  pendingGptKeyCooldownWrites++;
  // A read issued before the upsert commits must not drop the local mark.
  lastGptKeyCooldownDbCheckMs = Date.now();
  try {
    await prisma.integration.upsert({
      where: {
        userId_name_accountId: {
          userId: GPT_API_KEY_COOLDOWN_USER_ID,
          name: GPT_API_KEY_COOLDOWN_NAME,
          accountId: '',
        },
      },
      create: {
        userId: GPT_API_KEY_COOLDOWN_USER_ID,
        name: GPT_API_KEY_COOLDOWN_NAME,
        type: 'TOOL_SETUP',
        status: 'NOT_CONNECTED',
        rateLimitedUntil: until,
        failureReason: reason,
      },
      update: { rateLimitedUntil: until, failureReason: reason },
    });
  } finally {
    pendingGptKeyCooldownWrites--;
  }
  log.warn('Funded GPT API key backed off', { reason, until: until.toISOString() });
}

export async function __resetGptApiKeyCooldown(): Promise<void> {
  __clearGptApiKeyCooldownCache();
  await prisma.integration.deleteMany({
    where: {
      userId: GPT_API_KEY_COOLDOWN_USER_ID,
      name: GPT_API_KEY_COOLDOWN_NAME,
    },
  });
}

export async function markGptUserTokenRateLimited(
  userId: string,
  options?: {
    rateLimitedUntil?: string | Date | null;
    failureReason?: string | null;
    accountId?: string | null;
    integrationId?: string | null;
  }
): Promise<void> {
  if (isIntegrationAuthFailureReason(options?.failureReason)) {
    const scopedWhere = {
      userId,
      name: 'gpt_code' as const,
      status: 'CONNECTED' as const,
      ...(options?.integrationId ? { id: options.integrationId } : {}),
      ...(options?.accountId ? { accountId: options.accountId } : {}),
    };
    // S33/T7: an auth failure must name the credential that failed. Without an
    // integration or account id it cannot tell the failed login from the user's
    // other rows, so it expires none (prod: updated:3 with integrationId:null).
    if (!options?.integrationId && !options?.accountId) {
      log.warn(`GPT user token auth failure for ${userId} names no credential; not expiring`, {
        failureReason: options?.failureReason,
      });
      return;
    }
    const updated = await prisma.integration.updateMany({
      where: scopedWhere,
      data: {
        status: 'EXPIRED',
        isActive: false,
        rateLimitedUntil: null,
        failureReason: options.failureReason,
      },
    });
    log.info(`GPT user token for ${userId} disabled after ${options.failureReason}`, {
      updated: updated.count,
      accountId: options?.accountId ?? null,
      integrationId: options?.integrationId ?? null,
    });
    // Resolve account identity before syncing chips — never broadly mark with an
    // absent ID when the Integration row (or scoped options) already carries one.
    let resolvedAccountId = options?.accountId?.trim() ?? '';
    if (resolvedAccountId === '' && options?.integrationId) {
      const row = await prisma.integration.findUnique({
        where: { id: options.integrationId },
        select: { accountId: true },
      });
      resolvedAccountId = row?.accountId?.trim() ?? '';
    }
    if (resolvedAccountId === '' && updated.count > 0) {
      const affected = await prisma.integration.findMany({
        where: {
          userId,
          name: 'gpt_code',
          status: 'EXPIRED',
          failureReason: options.failureReason,
          ...(options?.integrationId ? { id: options.integrationId } : {}),
        },
        select: { accountId: true },
      });
      const uniqueIds = [
        ...new Set(affected.map((row) => row.accountId?.trim() ?? '').filter((id) => id !== '')),
      ];
      if (uniqueIds.length > 0) {
        for (const accountId of uniqueIds) {
          await markConnectionNeedsReconnectFromIntegrationFailure({
            userId,
            integrationName: 'gpt_code',
            accountId,
            failureReason: options.failureReason,
          });
        }
        return;
      }
    }
    // An integration-scoped failure without an account identity must not fall
    // into the legacy user-wide branch, which would flag sibling accounts.
    if (resolvedAccountId === '' && options?.integrationId) return;
    await markConnectionNeedsReconnectFromIntegrationFailure({
      userId,
      integrationName: 'gpt_code',
      accountId: resolvedAccountId === '' ? null : resolvedAccountId,
      failureReason: options.failureReason,
    });
    return;
  }

  const until = resolveRateLimitedUntil(options?.rateLimitedUntil);
  const { count } = await prisma.integration.updateMany({
    where: {
      userId,
      name: 'gpt_code',
      status: 'CONNECTED',
      ...(options?.integrationId ? { id: options.integrationId } : {}),
      ...(options?.accountId ? { accountId: options.accountId } : {}),
      ...notAlreadyBackedOffLonger(until),
    },
    data: { rateLimitedUntil: until },
  });
  if (count === 0) {
    const existing = await prisma.integration.count({
      where: { userId, name: 'gpt_code', status: 'CONNECTED' },
    });
    if (existing === 0) {
      log.warn(`No gpt_code integration for ${userId}; nothing to rate-limit`);
      return;
    }
    log.info(
      `GPT user token for ${userId} already backed off past ${until.toISOString()} — keeping the longer window`
    );
    return;
  }
  log.info(`GPT user token for ${userId} rate-limited until ${until.toISOString()}`);
}

/**
 * The stored access token of a `gpt_code` login and its JWT expiry, for comparing
 * with the token a sandbox held when Codex reported it unusable
 * (codeLoginRejection.ts). A malformed `exp` reads as expired, as when serving.
 */
export async function storedCodexLogin(
  integrationId: string
): Promise<StoredLogin | null | undefined> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) return undefined;
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { id: true, config: true },
  });
  const decrypted = integration ? decryptIntegrationCredentials(integration, decryptionKey) : null;
  const parsed = decrypted ? parseGptCodeEnvelope(decrypted) : null;
  if (!parsed) return null;
  const expiresAt = codexAccessTokenExpiry(parsed.accessToken);
  return { accessToken: parsed.accessToken, expiresAt: expiresAt === 'malformed' ? 0 : expiresAt };
}

/**
 * Whether this `gpt_code` row's stored access token is provably inside Codex's
 * refresh window (or malformed), so serving skips it (toSandboxCodexAuthJson).
 * Credential availability (codeSessions/usageLimit.ts) excludes such rows.
 */
export function hasExpiredCodexToken(row: { id: string; config: unknown }): boolean {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  const decrypted = decryptionKey ? decryptIntegrationCredentials(row, decryptionKey) : null;
  const parsed = decrypted ? parseGptCodeEnvelope(decrypted) : null;
  if (!parsed) return false;
  const expiresAt = codexAccessTokenExpiry(parsed.accessToken);
  return (
    expiresAt === 'malformed' ||
    (expiresAt !== null && expiresAt <= Date.now() + CODEX_ACCESS_TOKEN_REFRESH_WINDOW_MS)
  );
}

export async function fetchGptCodeAccessToken(
  userId: string
): Promise<{ accessToken: string; accountId?: string } | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) return null;

  const now = new Date();
  const integration = await prisma.integration.findFirst({
    where: {
      userId,
      name: 'gpt_code',
      status: 'CONNECTED',
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
    },
  });
  if (!integration) return null;

  const decrypted = decryptIntegrationCredentials(integration, decryptionKey);
  return decrypted ? parseGptCodeEnvelope(decrypted) : null;
}
