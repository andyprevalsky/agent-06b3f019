/**
 * Read-only view of a stored Claude OAuth credential envelope
 * (`{ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes } }`) as the
 * compute-token lease path needs it.
 */

export type ClaudeEnvelope = {
  accessToken: string;
  refreshable: boolean;
  /** Epoch ms of the access token's own expiry; null when the envelope omits it. */
  expiresAt: number | null;
  inferenceScope: boolean;
};

export function parseClaudeEnvelope(credentialsJson: string): ClaudeEnvelope | null {
  try {
    const parsed = JSON.parse(credentialsJson) as Record<string, unknown>;
    const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
    const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken : '';
    if (accessToken.length === 0) return null;
    const refreshToken = typeof oauth?.refreshToken === 'string' ? oauth.refreshToken : '';
    const rawExpiresAt = oauth?.expiresAt;
    // Omitted -> unknown (null). Present but not a positive finite epoch is not
    // a usable expiry, so it is treated as already expired (0).
    const expiresAt =
      rawExpiresAt === undefined || rawExpiresAt === null
        ? null
        : typeof rawExpiresAt === 'number' && Number.isFinite(rawExpiresAt) && rawExpiresAt > 0
          ? rawExpiresAt
          : 0;
    const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes : [];
    return {
      accessToken,
      refreshable: refreshToken.length > 0,
      expiresAt,
      inferenceScope: scopes.some((scope) => scope === 'user:inference'),
    };
  } catch {
    return null;
  }
}

/**
 * The expiry instant when the access token is already past its own `expiresAt`,
 * else null. The server never refreshes a Claude grant: Anthropic refresh tokens
 * are single-use and refreshing revokes the access token the user's own Claude
 * Code holds (see compute-token-semantics.blackbox.ts). An access token past its
 * own expiry is therefore provably dead on the lease path -- leasing it only buys
 * a guaranteed 401 "OAuth access token has expired" and a silent provider
 * failover, which a stale keychain re-upload caused on 2026-10-20. Like Claude
 * Code's `isOAuthTokenExpired`, an envelope without `expiresAt` is not expired.
 */
export function claudeEnvelopeExpiredAt(envelope: ClaudeEnvelope, now: number): number | null {
  return envelope.expiresAt !== null && envelope.expiresAt <= now ? envelope.expiresAt : null;
}

export function isUsableClaudePoolEnvelope(envelope: ClaudeEnvelope): boolean {
  // Legacy browser OAuth envelopes carry a refresh lineage. Cloud-minted
  // setup-tokens are year-long inference grants with an empty refreshToken and
  // a real expiresAt; rejecting every empty refresh token made those healthy,
  // explicitly-pooled accounts invisible to the pool.
  const liveSetupToken = envelope.expiresAt !== null && envelope.inferenceScope;
  return envelope.accessToken.startsWith('sk-ant-oat') && (envelope.refreshable || liveSetupToken);
}
