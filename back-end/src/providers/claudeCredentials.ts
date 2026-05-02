import crypto from 'crypto';
import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('ClaudeCredentials');

/**
 * Decrypt an RSA+AES-GCM encrypted envelope.
 * Mirrors the Python decrypt_password() in agents/tools/spawn_browser_agent_v3.py.
 *
 * @param encryptedEnvelope - Base64-encoded JSON envelope with encrypted_aes_key, iv, ciphertext
 * @param decryptionKeyB64 - Base64-encoded PEM RSA private key
 * @returns Decrypted plaintext string, or null on failure
 */
export function decryptCredentialEnvelope(
  encryptedEnvelope: string,
  decryptionKeyB64: string
): string | null {
  try {
    const envelopeJson = Buffer.from(encryptedEnvelope, 'base64').toString('utf8');
    const envelope = JSON.parse(envelopeJson);

    if (envelope.version !== 1) {
      log.error('Unknown envelope version', { version: envelope.version });
      return null;
    }

    if (!envelope.encrypted_aes_key || !envelope.iv || !envelope.ciphertext) {
      log.error('Malformed envelope: missing encrypted_aes_key, iv, or ciphertext');
      return null;
    }

    // Load RSA private key from base64-encoded PEM
    const privateKeyPem = Buffer.from(decryptionKeyB64, 'base64').toString('utf8');

    // Decrypt AES key with RSA-OAEP
    const encryptedAesKey = Buffer.from(envelope.encrypted_aes_key, 'base64');
    const aesKey = crypto.privateDecrypt(
      {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      encryptedAesKey
    );

    // Decrypt data with AES-256-GCM
    const iv = Buffer.from(envelope.iv, 'base64');
    const ciphertextWithTag = Buffer.from(envelope.ciphertext, 'base64');
    const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
    const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return plaintext.toString('utf8');
  } catch (error) {
    log.error('Failed to decrypt credential envelope', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Result of a Claude Code credential lookup, with tracking metadata so callers
 * can mark the underlying integration rate-limited if the CLI reports
 * exhaustion ("You've hit your limit · resets X:XX (UTC)").
 */
export interface ClaudeCodeCredentialResult {
  /** Decrypted credentials JSON string (the `claudeAiOauth` envelope). */
  credentials: string;
  /** Whether this came from the user's own integration or the shared pool. */
  source: 'user' | 'pool';
  /** Owning user (when source='user') or the foreign user the pool token belongs to (when source='pool'). */
  userId: string;
  /** Integration ID — set when source='pool' so rotation can mark it rate-limited. */
  poolTokenId?: string;
}

/**
 * Fetch and decrypt Claude Code credentials for a user.
 * Returns the decrypted credentials JSON string, or null if unavailable.
 *
 * Skips the user's own integration when `rateLimitedUntil` is in the future —
 * the agent's outer pool-rotation logic sets this when Anthropic returns 429,
 * and the same exhaustion almost always applies to the inner Claude Code CLI.
 */
export async function fetchClaudeCodeCredentials(userId: string): Promise<string | null> {
  const result = await fetchClaudeCodeCredentialsWithMeta(userId);
  return result?.credentials ?? null;
}

/**
 * Same as `fetchClaudeCodeCredentials` but also returns the source + integration ID
 * so the caller can mark the right token rate-limited on a "hit your limit" failure.
 *
 * Resolution order:
 *   1. User's own `claude_code` integration (if not rate-limited)
 *   2. Pool integration (least-recently-used non-rate-limited token)
 */
export async function fetchClaudeCodeCredentialsWithMeta(
  userId: string
): Promise<ClaudeCodeCredentialResult | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) {
    log.info('CLAUDE_CREDENTIAL_DECRYPTION_KEY not set, skipping credential lookup');
    return null;
  }

  try {
    const now = new Date();
    const userIntegration = await prisma.integration.findFirst({
      where: {
        userId,
        name: 'claude_code',
        status: 'CONNECTED',
        OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
      },
    });

    if (userIntegration) {
      const decrypted = decryptIntegrationCredentials(userIntegration, decryptionKey);
      if (decrypted) {
        log.info(`Serving user Claude Code credentials for ${userId}`);
        return { credentials: decrypted, source: 'user', userId };
      }
    } else {
      log.info(
        `No active claude_code integration for user ${userId} (none synced or rate-limited) — falling back to pool`
      );
    }

    const poolResult = await fetchPoolCredentials();
    if (poolResult) {
      return poolResult;
    }

    return null;
  } catch (error) {
    log.error(`Error fetching Claude Code credentials for user ${userId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function decryptIntegrationCredentials(
  integration: { id: string; config: unknown },
  decryptionKey: string
): string | null {
  const config = integration.config as Record<string, unknown> | null;
  const encryptedCredentials = config?.encryptedCredentials as string | undefined;
  if (!encryptedCredentials) {
    log.info(`claude_code integration ${integration.id} has no encryptedCredentials`);
    return null;
  }

  const decrypted = decryptCredentialEnvelope(encryptedCredentials, decryptionKey);
  if (!decrypted) {
    log.error(`Failed to decrypt claude_code integration ${integration.id}`);
    return null;
  }
  return decrypted;
}

/**
 * Fetch and decrypt the FULL credentials envelope for an available pool token,
 * for use by the inner Claude Code CLI (which needs the OAuth refresh + access
 * token, not just the access token).
 *
 * Selects the least-recently-used non-rate-limited pool integration; updates
 * `lastUsedAt` for LRU ordering. Returns null if no usable pool token exists.
 */
export async function fetchPoolCredentials(
  excludeIds?: string[]
): Promise<ClaudeCodeCredentialResult | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) {
    log.info('CLAUDE_CREDENTIAL_DECRYPTION_KEY not set, skipping pool lookup');
    return null;
  }

  try {
    const now = new Date();
    const poolIntegrations = await prisma.integration.findMany({
      where: {
        name: 'claude_code',
        status: 'CONNECTED',
        poolingEnabled: true,
        OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
        ...(excludeIds?.length ? { id: { notIn: excludeIds } } : {}),
      },
      orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }],
    });

    if (poolIntegrations.length === 0) {
      log.info('No available pool credentials for Claude Code CLI');
      return null;
    }

    for (const poolIntegration of poolIntegrations) {
      const decrypted = decryptIntegrationCredentials(poolIntegration, decryptionKey);
      if (!decrypted) continue;
      if (!hasUsableClaudeCodeEnvelope(decrypted)) {
        log.warn(
          `Pool integration ${poolIntegration.id} (user: ${poolIntegration.userId}) has incomplete OAuth envelope (missing refreshToken or invalid format) — skipping`
        );
        continue;
      }

      await prisma.integration.update({
        where: { id: poolIntegration.id },
        data: { lastUsedAt: now },
      });

      log.info(
        `Serving pool Claude Code credentials from integration ${poolIntegration.id} (user: ${poolIntegration.userId})`
      );
      return {
        credentials: decrypted,
        source: 'pool',
        userId: poolIntegration.userId,
        poolTokenId: poolIntegration.id,
      };
    }

    log.info(
      `${poolIntegrations.length} pool integrations matched but none had a usable OAuth envelope — falling back to caller default`
    );
    return null;
  } catch (error) {
    log.error('Error fetching pool credentials', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Validate that a decrypted Claude Code credentials JSON contains the fields
 * the CLI needs to authenticate without prompting for `/login`. The CLI expects
 * `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, ... } }` — without
 * `refreshToken` it cannot recover from a rejected access token and emits the
 * "Please run /login" message that aborts the sandbox activity. This guard
 * prevents the pool from serving partial envelopes that we know will fail.
 *
 * Also rejects obvious test/seed envelopes (e.g. `seed-token-xxx` /
 * `test-refresh`) — these pass the structural length check but fail
 * authentication on the very first request. Real Anthropic OAuth tokens
 * always start with `sk-ant-oat01-`, so rejecting envelopes that lack that
 * prefix saves an entire E2B sandbox spin-up per dud token.
 */
function hasUsableClaudeCodeEnvelope(credentialsJson: string): boolean {
  try {
    const parsed = JSON.parse(credentialsJson) as Record<string, unknown>;
    const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
    if (!oauth) return false;
    const accessToken = typeof oauth.accessToken === 'string' ? oauth.accessToken : '';
    const refreshToken = typeof oauth.refreshToken === 'string' ? oauth.refreshToken : '';
    if (accessToken.length === 0 || refreshToken.length === 0) return false;
    // Real Anthropic OAuth access tokens are minted with this prefix; anything
    // else is a placeholder (seed data, tests) that will 401 immediately.
    if (!accessToken.startsWith('sk-ant-oat')) return false;
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// POOL TOKEN FUNCTIONS
// =============================================================================

const POOL_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function resolveRateLimitedUntil(
  rateLimitedUntil?: string | Date | null,
  cooldownMs: number = POOL_RATE_LIMIT_COOLDOWN_MS
): Date {
  if (rateLimitedUntil instanceof Date) return rateLimitedUntil;
  if (typeof rateLimitedUntil === 'string') {
    const parsed = new Date(rateLimitedUntil);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() + cooldownMs);
}

/**
 * Fetch an available pool token from Integrations with poolingEnabled=true.
 * Selects the least-recently-used token that isn't rate-limited.
 * @param excludeIds - Integration IDs to skip (e.g. already tried and got 429)
 */
export async function fetchPoolToken(
  excludeIds?: string[]
): Promise<{ accessToken: string; poolTokenId: string } | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) {
    log.info('CLAUDE_CREDENTIAL_DECRYPTION_KEY not set, skipping pool lookup');
    return null;
  }

  try {
    const now = new Date();
    const poolIntegration = await prisma.integration.findFirst({
      where: {
        name: 'claude_code',
        status: 'CONNECTED',
        poolingEnabled: true,
        OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
        ...(excludeIds?.length ? { id: { notIn: excludeIds } } : {}),
      },
      orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }],
    });

    if (!poolIntegration) {
      log.info('No available pool tokens');
      return null;
    }

    const config = poolIntegration.config as Record<string, unknown> | null;
    const encryptedCredentials = config?.encryptedCredentials as string | undefined;
    if (!encryptedCredentials) {
      log.error(`Pool integration ${poolIntegration.id} missing encryptedCredentials`);
      return null;
    }

    const decrypted = decryptCredentialEnvelope(encryptedCredentials, decryptionKey);
    if (!decrypted) {
      log.error(`Failed to decrypt pool integration ${poolIntegration.id}`);
      return null;
    }

    const parsed = JSON.parse(decrypted);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth?.accessToken) {
      log.error(`Pool integration ${poolIntegration.id} missing accessToken`);
      return null;
    }

    // Update lastUsedAt for LRU ordering
    await prisma.integration.update({
      where: { id: poolIntegration.id },
      data: { lastUsedAt: now },
    });

    log.info(
      `Serving pool token from integration ${poolIntegration.id} (user: ${poolIntegration.userId})`
    );
    return { accessToken: oauth.accessToken, poolTokenId: poolIntegration.id };
  } catch (error) {
    log.error('Error fetching pool token', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Mark a pool token as rate-limited for a cooldown period.
 */
export async function markPoolTokenRateLimited(
  poolTokenId: string,
  options?: {
    rateLimitedUntil?: string | Date | null;
    cooldownMs?: number;
  }
): Promise<void> {
  const until = resolveRateLimitedUntil(options?.rateLimitedUntil, options?.cooldownMs);
  await prisma.integration.update({
    where: { id: poolTokenId },
    data: { rateLimitedUntil: until },
  });
  log.info(`Pool token ${poolTokenId} rate-limited until ${until.toISOString()}`);
}

/**
 * Mark a user's Claude token integration as rate-limited for a cooldown period.
 */
export async function markUserTokenRateLimited(
  userId: string,
  options?: {
    rateLimitedUntil?: string | Date | null;
    cooldownMs?: number;
  }
): Promise<void> {
  const until = resolveRateLimitedUntil(options?.rateLimitedUntil, options?.cooldownMs);
  await prisma.integration.updateMany({
    where: {
      userId,
      name: 'claude_code',
      status: 'CONNECTED',
    },
    data: { rateLimitedUntil: until },
  });
  log.info(`User token for ${userId} rate-limited until ${until.toISOString()}`);
}

// =============================================================================
// USER TOKEN FUNCTIONS
// =============================================================================

/**
 * Fetch the Claude Code OAuth access token for a user.
 * Returns the token as-is — the mac app keeps tokens fresh via periodic keychain sync.
 */
export async function fetchClaudeCodeAccessToken(userId: string): Promise<string | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) {
    log.info('CLAUDE_CREDENTIAL_DECRYPTION_KEY not set');
    return null;
  }

  try {
    const now = new Date();
    const integration = await prisma.integration.findFirst({
      where: {
        userId,
        name: 'claude_code',
        status: 'CONNECTED',
        OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
      },
    });

    if (!integration) {
      log.info(`No claude_code integration found for user ${userId}`);
      return null;
    }

    const config = integration.config as Record<string, unknown> | null;
    const encryptedCredentials = config?.encryptedCredentials as string | undefined;
    if (!encryptedCredentials) return null;

    const decrypted = decryptCredentialEnvelope(encryptedCredentials, decryptionKey);
    if (!decrypted) return null;

    const parsed = JSON.parse(decrypted);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth?.accessToken) {
      log.error(`Credentials missing accessToken for user ${userId}`);
      return null;
    }

    return oauth.accessToken;
  } catch (error) {
    log.error(`Failed to fetch access token for user ${userId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Fetch a Claude token for a user: tries their personal token first, then pool.
 * Returns just the access token string, or null if unavailable.
 */
export async function fetchClaudeTokenForUser(userId: string): Promise<string | null> {
  const userToken = await fetchClaudeCodeAccessToken(userId);
  if (userToken) return userToken;
  const poolResult = await fetchPoolToken();
  return poolResult?.accessToken ?? null;
}
