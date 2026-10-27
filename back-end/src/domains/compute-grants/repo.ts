/**
 * Persistence for compute grants and account connections.
 *
 * Implements the `GrantStore` seam used by `ComputeGrantReminter`, so the
 * orchestration logic stays testable without a database while production gets
 * real rows.
 *
 * TWO INVARIANTS ENFORCED HERE RATHER THAN BY CONSTRAINTS
 * ------------------------------------------------------
 * 1. EXACTLY ONE ACTIVE GRANT per (connection, surface). Prisma cannot express a
 *    partial unique index, so `saveGrant` retires the previous active grant and
 *    inserts the new one inside a single transaction. Doing this in two
 *    statements outside a transaction would leave a window where an agent picks
 *    up a grant that is about to be retired.
 *
 * 2. GRANT HISTORY IS KEPT. Dead grants are marked, never deleted, so a
 *    revocation can be traced afterwards -- which is the observability gap that
 *    let a token sit dead for 18 days unnoticed.
 *
 * Multiple accounts per user fall out of the schema: the connection is keyed by
 * (userId, provider, accountId), mirroring EmailIntegrationCredential's
 * (userId, provider, email). Nothing here is keyed by provider alone.
 */

import { createCipheriv, randomBytes, publicEncrypt, constants } from 'node:crypto';

import { prisma, runTransactionWithRetry } from '../../providers/database';
import { credentialDecryptionKeyB64, credentialPublicKeyPem } from './config';
import { decryptCredentialEnvelope } from '../../providers/claudeCredentials';
import type {
  AccountConnectionState,
  ComputeGrantRecord,
  GrantStore,
} from '../../providers/computeGrantRemint';

/** RSA+AES-GCM envelope, byte-compatible with the existing credential envelopes. */
export function encryptGrantMaterial(plaintext: string): string {
  if (plaintext.length === 0) throw new Error('encryptGrantMaterial: plaintext must be non-empty');
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
  const encryptedAesKey = publicEncrypt(
    {
      key: credentialPublicKeyPem(),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );
  return Buffer.from(
    JSON.stringify({
      version: 1,
      encrypted_aes_key: encryptedAesKey.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    })
  ).toString('base64');
}

/**
 * Does this user already pool their compute tokens?
 *
 * Read from the existing Integration rows so a newly connected account inherits
 * the user's established choice. Without this, every account added through the
 * new flow would silently default to NOT pooling, and a user who pools today
 * would quietly lose pool capacity as they migrate -- a regression that looks
 * like "the new accounts just aren't being used".
 */
export async function userPoolingDefault(userId: string): Promise<boolean> {
  const [pooledIntegration, pooledConnection] = await Promise.all([
    prisma.integration.findFirst({
      where: { userId, poolingEnabled: true },
      select: { id: true },
    }),
    prisma.computeAccountConnection.findFirst({
      where: { userId, poolingEnabled: true },
      select: { id: true },
    }),
  ]);
  return pooledIntegration !== null || pooledConnection !== null;
}

export interface UpsertConnectionInput {
  userId: string;
  provider: string;
  accountId: string;
  accountEmail?: string;
  /** Raw account session (cookies). Encrypted before it touches the database. */
  session?: string;
  sessionExpiresAt?: Date;
  /** Explicit user choice. When omitted, the user's existing pooling is inherited. */
  poolingEnabled?: boolean;
}

/** Link or refresh an account connection. This is what "Add account" writes. */
export async function upsertAccountConnection(input: UpsertConnectionInput) {
  const encryptedSession =
    input.session !== undefined ? encryptGrantMaterial(input.session) : undefined;
  // Explicit choice wins; otherwise inherit whatever the user already does.
  const pooling = input.poolingEnabled ?? (await userPoolingDefault(input.userId));
  return prisma.computeAccountConnection.upsert({
    where: {
      userId_provider_accountId: {
        userId: input.userId,
        provider: input.provider,
        accountId: input.accountId,
      },
    },
    create: {
      userId: input.userId,
      provider: input.provider,
      accountId: input.accountId,
      accountEmail: input.accountEmail,
      encryptedSession,
      sessionExpiresAt: input.sessionExpiresAt,
      state: 'connected',
      poolingEnabled: pooling,
      ...(input.poolingEnabled !== undefined
        ? { poolingEnabledOverride: input.poolingEnabled }
        : {}),
    },
    update: {
      accountEmail: input.accountEmail,
      // A refreshed session always heals the connection: re-linking is the
      // documented recovery for `needs_reconnect`.
      ...(encryptedSession !== undefined
        ? { encryptedSession, state: 'connected', lastErrorReason: null }
        : {}),
      sessionExpiresAt: input.sessionExpiresAt,
      // Only an EXPLICIT choice may change pooling on an existing account;
      // re-connecting to refresh a session must not silently flip it.
      ...(input.poolingEnabled !== undefined
        ? { poolingEnabled: input.poolingEnabled, poolingEnabledOverride: input.poolingEnabled }
        : {}),
    },
  });
}

/** Decrypted account session, for the cloud minter. Null when absent/undecryptable. */
export async function getConnectionSession(
  userId: string,
  provider: string,
  accountId: string
): Promise<string | null> {
  const row = await prisma.computeAccountConnection.findUnique({
    where: { userId_provider_accountId: { userId, provider, accountId } },
  });
  if (row === null || row.encryptedSession === null) return null;
  return decryptCredentialEnvelope(row.encryptedSession, credentialDecryptionKeyB64());
}

/** Every connected account for a user -- drives the FE chips. */
export async function listConnections(userId: string, provider?: string) {
  return prisma.computeAccountConnection.findMany({
    where: { userId, ...(provider !== undefined ? { provider } : {}) },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Remove one connected account. Grants cascade.
 *
 * Scoped to a single accountId on purpose: removing one chip must never disturb
 * the others, which is the eviction class this whole redesign exists to avoid.
 */
export async function removeConnection(userId: string, provider: string, accountId: string) {
  return prisma.computeAccountConnection.deleteMany({
    where: { userId, provider, accountId },
  });
}

export function createPrismaGrantStore(surface = 'cloud'): GrantStore {
  return {
    async getActiveGrant(userId, provider, accountId): Promise<ComputeGrantRecord | null> {
      const row = await prisma.computeGrant.findFirst({
        where: { userId, provider, accountId, surface, status: 'active' },
        orderBy: { mintedAt: 'desc' },
      });
      if (row === null) return null;
      const accessToken = decryptCredentialEnvelope(
        row.encryptedCredentials,
        credentialDecryptionKeyB64()
      );
      if (accessToken === null) return null;
      return {
        grantId: row.id,
        userId: row.userId,
        provider: row.provider as 'claude' | 'codex',
        accountId: row.accountId,
        accessToken,
      };
    },

    async markGrantDead(grantId, reason) {
      // Idempotent: re-marking an already-dead grant is a no-op, which matters
      // because many concurrent agents can observe the same revocation.
      await prisma.computeGrant.updateMany({
        where: { id: grantId, status: 'active' },
        data: { status: 'dead', deadReason: reason.slice(0, 500), diedAt: new Date() },
      });
    },

    async saveGrant(record): Promise<ComputeGrantRecord> {
      const connection = await prisma.computeAccountConnection.findUnique({
        where: {
          userId_provider_accountId: {
            userId: record.userId,
            provider: record.provider,
            accountId: record.accountId,
          },
        },
      });
      if (connection === null) {
        throw new Error(
          `no account connection for ${record.provider}/${record.accountId}; ` +
            'a grant can only be minted from a connected account'
        );
      }
      const encrypted = encryptGrantMaterial(record.accessToken);

      // Retire-then-insert in ONE transaction: outside a transaction there is a
      // window where an agent reads a grant that is about to be superseded.
      // Uses the shared helper so timeout and transaction-start retry policy
      // match every other domain (enforced by the layer-deps structural test).
      const created = await runTransactionWithRetry(async (tx) => {
        await tx.computeGrant.updateMany({
          where: { connectionId: connection.id, surface, status: 'active' },
          data: { status: 'dead', deadReason: 'superseded by re-mint', diedAt: new Date() },
        });
        return tx.computeGrant.create({
          data: {
            connectionId: connection.id,
            userId: record.userId,
            provider: record.provider,
            accountId: record.accountId,
            surface,
            grantType: record.provider === 'claude' ? 'setup_token' : 'oauth_refresh',
            encryptedCredentials: encrypted,
            status: 'active',
          },
        });
      });

      return {
        grantId: created.id,
        userId: created.userId,
        provider: created.provider as 'claude' | 'codex',
        accountId: created.accountId,
        accessToken: record.accessToken,
      };
    },

    async setConnectionState(userId, provider, accountId, state: AccountConnectionState) {
      await prisma.computeAccountConnection.updateMany({
        where: { userId, provider, accountId },
        data: { state, ...(state === 'connected' ? { lastErrorReason: null } : {}) },
      });
    },
  };
}

export interface LocalCookieRow {
  name: string;
  value: string;
  domain: string;
  path: string;
  isSecure: boolean;
  isHttpOnly: boolean;
  expiresUtc: bigint | null;
  /** Chrome's integer SameSite; see chromeSameSiteToCdp. */
  sameSite: number | null;
  browserSource: string | null;
  browserProfile: string | null;
}

/**
 * Locally-synced browser cookies for these domains, used to seed a cloud browser.
 *
 * `endsWith` covers the leading-dot host form (".claude.ai") Chromium writes for
 * domain cookies; matching on equality alone silently drops the session cookie,
 * which is the only one that actually matters for sign-in.
 */
export async function findLocalCookiesForDomains(
  userId: string,
  domains: string[]
): Promise<LocalCookieRow[]> {
  return prisma.cookie.findMany({
    where: { userId, OR: domains.map((d) => ({ domain: { endsWith: d } })) },
    select: {
      name: true,
      value: true,
      domain: true,
      path: true,
      isSecure: true,
      isHttpOnly: true,
      expiresUtc: true,
      // Required for Google: its multi-login cookies are SameSite=None, and
      // omitting the attribute makes Chrome default them to Lax, so they are
      // never sent on the cross-site request the account chooser performs.
      sameSite: true,
      // A cookie only means something together with the rest of ITS profile's
      // jar -- see pickSingleProfile.
      browserSource: true,
      browserProfile: true,
    },
  });
}

/**
 * Keep cookies from exactly ONE browser profile.
 *
 * A user has several Chrome profiles, each with its own Google session, and
 * every one stores `SID` / `__Secure-1PSID` / `HSID` for `.google.com`. Injecting
 * them all into a single jar means last-write-wins per name, producing a
 * Frankenstein session -- `SID` from one profile, `HSID` from another. Google
 * validates these as a set, so the account chooser listed the accounts but
 * reported every one as "Signed out".
 *
 * The winner is the profile with the most cookies for the requested domains,
 * which is the one whose session is most complete.
 */
export { pickCoherentProfile as pickSingleProfile } from '../../providers/browserCookies'; /**
 * Chrome stores SameSite as an integer; CDP expects the string form.
 * -1/absent = unspecified, 0 = None, 1 = Lax, 2 = Strict.
 */
export { chromeSameSiteToString as chromeSameSiteToCdp } from '../../providers/browserCookies';

/**
 * Materialise a minted grant as an `Integration` row.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every agent reads compute tokens through `fetchComputeTokenForUser`, which
 * queries `Integration` exclusively. Rather than teach that path about new
 * tables -- and own a dual-source selection race forever -- a minted grant is
 * written back in the BYTE-IDENTICAL envelope the existing reader already
 * consumes. Pooling, `rateLimitedUntil`, lineage leases and demo-cache affinity
 * therefore keep working with zero changes.
 *
 * Multi-account is possible because `Integration` is now keyed by
 * (userId, name, accountId). Legacy rows carry accountId "" and keep their old
 * uniqueness, so nothing pre-existing shifts.
 */
export interface MaterializeGrantInput {
  userId: string;
  provider: 'claude' | 'codex';
  accountId: string;
  accountEmail?: string;
  accessToken: string;
  /** Codex OAuth identity token, retained because auth.json is CLI input. */
  idToken?: string;
  /** Codex refresh lineage. Claude setup-tokens intentionally leave this empty. */
  refreshToken?: string;
  /** Seconds until expiry, as reported by the provider. */
  expiresInSeconds: number;
  poolingEnabled: boolean;
  /** Mirrors the exact connected account's explicit choice when it has one. */
  poolingEnabledOverride?: boolean | null;
}

/** Integration.name the compute reader looks for, per provider. */
function integrationNameFor(provider: 'claude' | 'codex'): string {
  return provider === 'claude' ? 'claude_code' : 'gpt_code';
}

/**
 * Build the credential JSON in the exact shape the reader expects.
 *
 * A Claude setup-token has NO refresh token, so `refreshToken` is empty. Codex
 * stores the id/access/refresh trio of auth.json; the sandbox reader
 * (gptCredentials.ts) serves it with the refresh token stripped. `expiresAt` is the real
 * far-future Claude expiry rather than 0, so nothing mistakes a healthy grant
 * for one needing refresh.
 */
export function buildGrantCredentialJson(input: MaterializeGrantInput): string {
  if (input.provider === 'claude') {
    return JSON.stringify({
      claudeAiOauth: {
        accessToken: input.accessToken,
        refreshToken: '',
        expiresAt: Date.now() + input.expiresInSeconds * 1000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
    });
  }
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: input.idToken ?? '',
      access_token: input.accessToken,
      refresh_token: input.refreshToken ?? '',
      account_id: input.accountId,
    },
    last_refresh: new Date().toISOString(),
  });
}

export async function materializeGrantAsIntegration(input: MaterializeGrantInput) {
  const name = integrationNameFor(input.provider);
  const encryptedCredentials = encryptGrantMaterial(buildGrantCredentialJson(input));
  return prisma.integration.upsert({
    where: {
      userId_name_accountId: { userId: input.userId, name, accountId: input.accountId },
    },
    create: {
      userId: input.userId,
      name,
      accountId: input.accountId,
      accountEmail: input.accountEmail,
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      poolingEnabled: input.poolingEnabled,
      poolingEnabledOverride: input.poolingEnabledOverride ?? null,
      config: { encryptedCredentials },
    },
    update: {
      accountEmail: input.accountEmail,
      status: 'CONNECTED',
      isActive: true,
      // The account connection is the source of truth. Re-minting must heal a
      // stale materialized row instead of preserving an obsolete pool flag.
      poolingEnabled: input.poolingEnabled,
      ...(input.poolingEnabledOverride !== undefined
        ? { poolingEnabledOverride: input.poolingEnabledOverride }
        : {}),
      config: { encryptedCredentials },
      // A freshly minted grant is healthy: clear any stale cooldown so it is
      // immediately selectable again.
      rateLimitedUntil: null,
      failureReason: null,
    },
  });
}
