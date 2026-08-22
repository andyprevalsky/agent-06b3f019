/**
 * Coinbase CDP treasury credentials.
 *
 * The treasury rail deliberately reads its OWN env vars before falling back to the shared `CDP_*`
 * pair. `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` are also consumed implicitly by `@coinbase/x402`'s
 * `facilitator` (see `server.ts`), so a key rotated for the treasury would silently change x402
 * settlement auth too. Dedicated `COINBASE_TREASURY_*` vars keep the two rails independently
 * rotatable; the fallback keeps single-key deployments working.
 *
 * `apiKeyId` accepts either form Coinbase issues:
 *   - bare uuid                                   `2f7ab3ec-...`
 *   - full resource name  `organizations/<org>/apiKeys/<uuid>`
 * Both are valid JWT `sub`/`kid` values; the full name is passed through untouched.
 */

export interface CoinbaseTreasuryConfig {
  apiKeyId: string;
  apiKeySecret: string;
  network: 'base' | 'base-sepolia';
}

export class CoinbaseTreasuryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoinbaseTreasuryConfigError';
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') return trimmed;
  }
  return undefined;
}

/** Read the treasury network. Only Base mainnet moves real USDC; sepolia is for rehearsal. */
export function treasuryNetworkFromEnvironment(): 'base' | 'base-sepolia' {
  const raw = process.env.COINBASE_TREASURY_NETWORK?.trim();
  if (raw === undefined || raw === '') return 'base';
  if (raw !== 'base' && raw !== 'base-sepolia') {
    throw new CoinbaseTreasuryConfigError(
      `COINBASE_TREASURY_NETWORK must be "base" or "base-sepolia" (got "${raw}")`
    );
  }
  return raw;
}

/**
 * Resolve treasury credentials, or `undefined` when the rail is not configured.
 *
 * Returns `undefined` rather than throwing so callers on the purchase hot path can degrade to
 * "no auto top-up" instead of failing a card mint.
 */
export function loadCoinbaseTreasuryConfig(): CoinbaseTreasuryConfig | undefined {
  const apiKeyId = firstNonEmpty(
    process.env.COINBASE_TREASURY_API_KEY_ID,
    process.env.CDP_API_KEY_ID
  );
  const apiKeySecret = firstNonEmpty(
    process.env.COINBASE_TREASURY_API_KEY_SECRET,
    process.env.CDP_API_KEY_SECRET
  );
  // NOTE: no wallet secret is required. The rail sends via the Coinbase v2 API using the key's
  // `Trade - Transfer` grant, not via CDP server wallets (which need a per-project wallet secret
  // AND completed business verification — neither of which this entity has).
  if (apiKeyId === undefined || apiKeySecret === undefined) return undefined;

  return { apiKeyId, apiKeySecret, network: treasuryNetworkFromEnvironment() };
}
