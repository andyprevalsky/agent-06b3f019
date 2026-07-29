import { prisma } from './database';
import { decryptCredentialEnvelope } from './claudeCredentials';
import { createLogger } from './logger';

const log = createLogger('GptCredentials');
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const GPT_API_KEY_COOLDOWN_MS = 30 * 60 * 1000;
const GPT_API_KEY_COOLDOWN_USER_ID = '00000000-0000-0000-0000-000000000000';
const GPT_API_KEY_COOLDOWN_NAME = 'gpt_api_key_cooldown';

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
    const refreshToken = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : '';
    if (accessToken.length === 0 || refreshToken.length === 0) return null;
    const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id : undefined;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

function hasUsableGptCodeEnvelope(credentialsJson: string): boolean {
  return parseGptCodeEnvelope(credentialsJson) !== null;
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
  const userIntegration = await prisma.integration.findFirst({
    where: {
      userId,
      name: 'gpt_code',
      status: 'CONNECTED',
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
    },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
  });

  if (userIntegration) {
    const decrypted = decryptIntegrationCredentials(userIntegration, decryptionKey);
    const parsed = decrypted ? parseGptCodeEnvelope(decrypted) : null;
    if (decrypted && parsed) {
      await prisma.integration.update({
        where: { id: userIntegration.id },
        data: { lastUsedAt: now },
      });
      log.info('Serving user GPT Code credentials', {
        userId,
        integrationId: userIntegration.id,
      });
      return {
        credentials: decrypted,
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
    if (!decrypted || !parsed || !hasUsableGptCodeEnvelope(decrypted)) continue;

    await prisma.integration.update({
      where: { id: poolIntegration.id },
      data: { lastUsedAt: now },
    });
    log.info('Serving pool GPT Code credentials', {
      integrationId: poolIntegration.id,
      userId: poolIntegration.userId,
    });
    return {
      credentials: decrypted,
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
  if (options?.failureReason === 'auth_error') {
    await prisma.integration.update({
      where: { id: poolTokenId },
      data: {
        poolingEnabled: false,
        rateLimitedUntil: null,
        failureReason: 'auth_error',
      },
    });
    log.info(`GPT pool token ${poolTokenId} disabled after auth_error`);
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

/** True when the shared funded GPT_API_KEY is currently backed off. */
export async function isGptApiKeyOnCooldown(): Promise<boolean> {
  const row = await prisma.integration.findUnique({
    where: {
      userId_name: {
        userId: GPT_API_KEY_COOLDOWN_USER_ID,
        name: GPT_API_KEY_COOLDOWN_NAME,
      },
    },
    select: { rateLimitedUntil: true },
  });
  return row?.rateLimitedUntil !== null && (row?.rateLimitedUntil?.getTime() ?? 0) > Date.now();
}

/** Back the shared funded GPT_API_KEY off after a provider quota response. */
export async function markGptApiKeyOnCooldown(reason: string): Promise<void> {
  const until = new Date(Date.now() + GPT_API_KEY_COOLDOWN_MS);
  await prisma.integration.upsert({
    where: {
      userId_name: {
        userId: GPT_API_KEY_COOLDOWN_USER_ID,
        name: GPT_API_KEY_COOLDOWN_NAME,
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
  log.warn('Funded GPT API key backed off', { reason, until: until.toISOString() });
}

export async function markGptUserTokenRateLimited(
  userId: string,
  options?: { rateLimitedUntil?: string | Date | null; failureReason?: string | null }
): Promise<void> {
  if (options?.failureReason === 'auth_error') {
    await prisma.integration.updateMany({
      where: { userId, name: 'gpt_code', status: 'CONNECTED' },
      data: {
        status: 'EXPIRED',
        isActive: false,
        rateLimitedUntil: null,
        failureReason: 'auth_error',
      },
    });
    log.info(`GPT user token for ${userId} disabled after auth_error`);
    return;
  }

  const until = resolveRateLimitedUntil(options?.rateLimitedUntil);
  const { count } = await prisma.integration.updateMany({
    where: { userId, name: 'gpt_code', status: 'CONNECTED', ...notAlreadyBackedOffLonger(until) },
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
