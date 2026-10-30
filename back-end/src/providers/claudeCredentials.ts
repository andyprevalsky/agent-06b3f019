import crypto from 'crypto';
import {
  isIntegrationAuthFailureReason,
  markConnectionNeedsReconnectFromIntegrationFailure,
  syncConnectionAfterIntegrationAuthFailure,
} from './integrationConnectionSync';
import { claudeEnvelopeExpiredAt, parseClaudeEnvelope } from './claudeOauthEnvelope';
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
 * Verify a client-provided credential envelope actually round-trips with the
 * server's private key BEFORE it is persisted. The upload path receives ciphertext
 * the client encrypted with a public key; if that key doesn't match ours (keypair
 * drift, wrong-env public key, malformed envelope), the ciphertext is unusable
 * garbage that later floods `oaep`/parse errors and silently degrades every request
 * for that user to the paid waterfall. Reject at the write boundary instead.
 *
 * Returns `{ ok: true }` when the key is unset (cannot validate — do not block), or
 * when the envelope decrypts to a non-empty plaintext. Returns `{ ok: false, reason }`
 * when we hold the key but the envelope will not decrypt.
 */
export function verifyCredentialEnvelopeDecryptable(
  encryptedCredentials: string
): { ok: true } | { ok: false; reason: string } {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) return { ok: true };
  const decrypted = decryptCredentialEnvelope(encryptedCredentials, decryptionKey);
  if (decrypted === null || decrypted.trim() === '') {
    return {
      ok: false,
      reason:
        'credential envelope does not decrypt to a non-empty payload with the server key (mismatched keypair or malformed envelope)',
    };
  }
  return { ok: true };
}

/**
 * Result of a Claude Code credential lookup, with tracking metadata so callers
 * can mark the underlying integration rate-limited if the CLI reports
 * exhaustion ("You've hit your limit · resets X:XX (UTC)").
 */
export interface ClaudeCodeCredentialResult {
  /** Decrypted credentials JSON string (the `claudeAiOauth` envelope). */
  credentials?: string;
  /** Decrypted OAuth access token, suitable for token-only callers. */
  accessToken?: string;
  /** How the sandbox should inject this credential. */
  credentialMode: 'oauth_envelope' | 'oauth_token';
  /** Whether this came from the user's own integration or the shared pool. */
  source: 'user' | 'pool';
  /** Owning user (when source='user') or the foreign user the pool token belongs to (when source='pool'). */
  userId: string;
  /** Integration ID — set when source='pool' so rotation can mark it rate-limited. */
  poolTokenId?: string;
  /**
   * The user's own Integration row (source='user'), so a usage limit marks
   * exactly that account and the user's other accounts stay leasable.
   */
  integrationId?: string;
}

/**
 * Resolve the Claude Code sandbox credential for a user, with the source +
 * integration ID so the caller can mark the right token rate-limited on a
 * "hit your limit" failure.
 *
 * Skips the user's own integration when `rateLimitedUntil` is in the future —
 * the agent's outer pool-rotation logic sets this when Anthropic returns 429,
 * and the same exhaustion almost always applies to the inner Claude Code CLI.
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
        const result = buildClaudeCodeCredentialResult(decrypted, 'user', userId);
        if (result) {
          log.info(`Serving user Claude Code credentials for ${userId}`);
          return { ...result, integrationId: userIntegration.id };
        }
        log.warn(`User Claude Code integration for ${userId} has no usable OAuth token`);
      }
    } else {
      log.info(
        `No active claude_code integration for user ${userId} (none synced or rate-limited)`
      );
    }

    // An EXPIRED (direct auth_error) row is never handed to a sandbox to
    // refresh: Claude refresh tokens are single-use and a refresh revokes every
    // other holder of the grant (see buildClaudeCodeCredentialResult). The user's
    // own Claude Code re-uploads a live token; until then the pool serves.
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
 * Fetch and decrypt the credentials of an available pool token for the inner
 * Claude Code CLI (access token only; see buildClaudeCodeCredentialResult).
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
      const result = buildClaudeCodeCredentialResult(
        decrypted,
        'pool',
        poolIntegration.userId,
        poolIntegration.id
      );
      if (!result) {
        log.warn(
          `Pool integration ${poolIntegration.id} (user: ${poolIntegration.userId}) has no usable OAuth token — skipping`
        );
        continue;
      }

      await prisma.integration.update({
        where: { id: poolIntegration.id },
        data: { lastUsedAt: now },
      });

      log.info(
        `Serving pool Claude Code credentials from integration ${poolIntegration.id} (user: ${poolIntegration.userId}, mode: ${result.credentialMode})`
      );
      return result;
    }

    log.info(
      `${poolIntegrations.length} pool integrations matched but none had a usable OAuth token`
    );
    return null;
  } catch (error) {
    log.error('Error fetching pool credentials', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** A sandbox must start with at least this much access-token lifetime left. */
const SANDBOX_MIN_ACCESS_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

/**
 * Convert a decrypted Claude Code credentials JSON into an access-token-only
 * sandbox credential (CLAUDE_CODE_OAUTH_TOKEN), or null when it is unusable.
 *
 * A stored envelope is a copy of a grant the user's own Claude Code (Mac
 * Keychain, devbox) still holds. Anthropic refresh tokens are single-use and a
 * refresh revokes every earlier access token of the grant
 * (compute-token-semantics.blackbox.ts), so a sandbox that refreshes signs the
 * user out everywhere and revokes concurrent sandboxes. The refresh token
 * therefore never leaves the server, and Claude Code treats an env token as
 * inference-only and never refreshes it. An access token that is expired or
 * about to expire is not served; its owner's device refreshes and re-uploads.
 * Obvious test/seed envelopes are rejected before they burn an E2B sandbox.
 */
function buildClaudeCodeCredentialResult(
  credentialsJson: string,
  source: 'user' | 'pool',
  userId: string,
  poolTokenId?: string
): ClaudeCodeCredentialResult | null {
  const envelope = parseClaudeEnvelope(credentialsJson);
  // Real Anthropic OAuth access tokens are minted with this prefix; anything
  // else is a placeholder (seed data, tests) that will 401 immediately.
  if (!envelope?.accessToken.startsWith('sk-ant-oat')) return null;
  // Like Claude Code, an envelope without `expiresAt` is not expired; a present
  // but malformed expiry parses as already expired.
  const mustOutliveAt = Date.now() + SANDBOX_MIN_ACCESS_TOKEN_LIFETIME_MS;
  if (claudeEnvelopeExpiredAt(envelope, mustOutliveAt) !== null) return null;
  return {
    source,
    userId,
    poolTokenId,
    accessToken: envelope.accessToken,
    credentialMode: 'oauth_token',
  };
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
 * Only ever EXTEND a backoff window — never shorten one.
 *
 * A token has exactly one `rateLimitedUntil`, but several independent consumers
 * write it: the Rose completions waterfall, the Claude Code CLI exhaustion
 * scanner, and the compute-token rotation endpoint. Some of those calls carry
 * the precise reset Anthropic reported ("resets 2026-07-30T22:00Z"); others
 * carry nothing and fall back to the generic short cooldown above.
 *
 * Before this guard the writes raced and the LAST one won, so a generic 5-minute
 * default could clobber a real multi-day reset. Observed in prod 2026-07-28:
 * 16:54:51 marked the user token until 2026-07-30T22:00:00Z, then 16:55:06
 * overwrote it with 17:00:06Z — so five minutes later the still-exhausted token
 * was served again, 429'd again, and in between the Claude Code path saw NO
 * usable credential and fell through to the unfunded shared ANTHROPIC_API_KEY
 * ("credit balance is too low" / 500 "No Claude Code credentials available").
 *
 * Expressed as a WHERE clause rather than read-modify-write so it stays a single
 * statement with no lost-update race, regardless of how many agents back the
 * same token off concurrently.
 */
function notAlreadyBackedOffLonger(until: Date) {
  return {
    OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: until } }],
  };
}

/**
 * Fetch an available pool token from Integrations with poolingEnabled=true.
 * Selects the least-recently-used token that isn't rate-limited.
 * @param excludeIds - Integration IDs to skip (e.g. already tried and got 429)
 */
export async function fetchPoolToken(
  excludeIds?: string[]
): Promise<{ accessToken: string; poolTokenId: string } | null> {
  const result = await fetchPoolCredentials(excludeIds);
  if (result?.accessToken !== undefined && result.poolTokenId !== undefined) {
    return { accessToken: result.accessToken, poolTokenId: result.poolTokenId };
  }
  if (result !== null) {
    log.warn(`Pool integration ${result.poolTokenId ?? 'unknown'} had no usable access token`);
    return null;
  }
  log.info('No available pool tokens');
  return null;
}

/**
 * Mark a pool token as rate-limited for a cooldown period.
 */
export async function markPoolTokenRateLimited(
  poolTokenId: string,
  options?: {
    rateLimitedUntil?: string | Date | null;
    cooldownMs?: number;
    failureReason?: string | null;
  }
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
    log.info(`Pool token ${poolTokenId} disabled after ${options.failureReason}`);
    await syncConnectionAfterIntegrationAuthFailure({
      integrationId: poolTokenId,
      failureReason: options.failureReason,
    });
    return;
  }

  const until = resolveRateLimitedUntil(options?.rateLimitedUntil, options?.cooldownMs);
  const { count } = await prisma.integration.updateMany({
    where: { id: poolTokenId, ...notAlreadyBackedOffLonger(until) },
    data: { rateLimitedUntil: until },
  });
  if (count === 0) {
    // `updateMany` matched nothing, which has TWO causes: the row already has a
    // longer window (expected, benign), or the id does not exist (a stale-ID bug
    // the previous single-record `update` would have thrown on). Disambiguate so
    // the guard cannot silently swallow the second case.
    const existing = await prisma.integration.findUnique({
      where: { id: poolTokenId },
      select: { rateLimitedUntil: true },
    });
    if (existing === null) {
      log.warn(`Pool token ${poolTokenId} not found; cannot rate-limit (stale integration id?)`);
      return;
    }
    log.info(
      `Pool token ${poolTokenId} already backed off past ${until.toISOString()} ` +
        `(until ${existing.rateLimitedUntil?.toISOString() ?? 'null'}) — keeping the longer window`
    );
    return;
  }
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
    failureReason?: string | null;
    accountId?: string | null;
    integrationId?: string | null;
  }
): Promise<void> {
  if (isIntegrationAuthFailureReason(options?.failureReason)) {
    const scopedWhere = {
      userId,
      name: 'claude_code' as const,
      status: { in: ['CONNECTED', 'EXPIRED'] as Array<'CONNECTED' | 'EXPIRED'> },
      ...(options?.integrationId ? { id: options.integrationId } : {}),
      ...(options?.accountId ? { accountId: options.accountId } : {}),
    };
    // S33: an auth failure must name the credential that failed. Without an
    // integration or account id it cannot tell a user's accounts apart, so it
    // never expires more than one row (one bad token expired every healthy
    // sibling subscription).
    if (!options?.integrationId && !options?.accountId) {
      const candidates = await prisma.integration.count({
        where: { ...scopedWhere, status: 'CONNECTED' },
      });
      if (candidates > 1) {
        log.warn(`User token auth failure for ${userId} names no credential; not expiring`, {
          candidates,
          failureReason: options?.failureReason,
        });
        return;
      }
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
    log.info(`User token for ${userId} disabled after ${options.failureReason}`, {
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
          name: 'claude_code',
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
            integrationName: 'claude_code',
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
      integrationName: 'claude_code',
      accountId: resolvedAccountId === '' ? null : resolvedAccountId,
      failureReason: options.failureReason,
    });
    return;
  }

  const until = resolveRateLimitedUntil(options?.rateLimitedUntil, options?.cooldownMs);
  const { count } = await prisma.integration.updateMany({
    where: {
      userId,
      name: 'claude_code',
      status: { in: ['CONNECTED', 'EXPIRED'] },
      ...(options?.integrationId ? { id: options.integrationId } : {}),
      ...(options?.accountId ? { accountId: options.accountId } : {}),
      ...notAlreadyBackedOffLonger(until),
    },
    data: { rateLimitedUntil: until },
  });
  if (count === 0) {
    // Same disambiguation as the pool path: no match means either an existing
    // longer window (benign) or no claude_code row at all for this user.
    const existing = await prisma.integration.count({
      where: { userId, name: 'claude_code', status: { in: ['CONNECTED', 'EXPIRED'] } },
    });
    if (existing === 0) {
      log.warn(`No claude_code integration for ${userId}; nothing to rate-limit`);
      return;
    }
    log.info(
      `User token for ${userId} already backed off past ${until.toISOString()} — keeping the longer window`
    );
    return;
  }
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
    if (!decrypted) {
      // Name the culprit so an undecryptable row is attributable (and quarantinable)
      // instead of only surfacing as an anonymous envelope-decrypt error.
      log.error(
        `Undecryptable claude_code credential for user ${userId} (integration ${integration.id}) — quarantine candidate`
      );
      return null;
    }

    const parsed = JSON.parse(decrypted);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth?.accessToken) {
      log.error(`Credentials missing accessToken for user ${userId}`);
      return null;
    }
    if (typeof oauth.accessToken !== 'string' || !oauth.accessToken.startsWith('sk-ant-oat')) {
      log.error(`Credentials for user ${userId} do not contain a real Claude OAuth access token`);
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
