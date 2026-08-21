/**
 * Coinbase USDC treasury — the float that refills the AgentCard org wallet.
 *
 * Implemented on the Coinbase **v2 API** (`POST /v2/accounts/{id}/transactions`, `type: "send"`),
 * NOT CDP server wallets. Rationale: the Rose CDP entity has no Server Wallet product provisioned
 * (its `/products/server-wallets` routes redirect, and signing fails with "Project has no secret"
 * because custodial APIs sit behind incomplete business verification). The existing API key already
 * carries `Trade - Transfer` on the Primary portfolio, which is exactly the grant `send` needs —
 * so this path works today with no additional provisioning.
 *
 * Money-safety notes:
 *  - Amounts cross this boundary as INTEGER CENTS. Decimal-string conversion happens here only.
 *  - Sends carry Coinbase's `idem` key, so a replayed send is de-duplicated provider-side rather
 *    than double-spending.
 */

import { createLogger } from '../logger';
import { CoinbaseApiError, coinbaseRequest, type CoinbaseCredentials } from './client';
import { loadCoinbaseTreasuryConfig, type CoinbaseTreasuryConfig } from './config';

const log = createLogger('CoinbaseTreasury');

/**
 * Coinbase rejects any `idem` that is not a bare UUID — a prefixed key like `rose-topup:<uuid>`
 * fails with `Invalid input parameter. Param: Idem`. Caught live: the very first real send died
 * on this, which would have broken EVERY automated top-up at the final step.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Coinbase's own floor: "The minimum amount you can send is 1 USDC." */
const MIN_SEND_CENTS = 100;

/** Coinbase's network identifier for Base on v2 sends. */
const NETWORK_IDS: Record<CoinbaseTreasuryConfig['network'], string> = {
  base: 'base',
  'base-sepolia': 'base-sepolia',
};

export class CoinbaseTreasuryError extends Error {
  readonly code: string;
  /** True when the failure happened after a send may have been accepted. */
  readonly possiblySent: boolean;

  constructor(message: string, code: string, possiblySent = false) {
    super(message);
    this.name = 'CoinbaseTreasuryError';
    this.code = code;
    this.possiblySent = possiblySent;
  }
}

export interface CoinbaseTreasury {
  getUsdcBalanceCents(): Promise<number>;
  /**
   * Un-converted USD sitting in the Coinbase cash account.
   *
   * The rail spends USDC, so cash here is inert — it looks like a funded treasury on a bank
   * statement while the float reads zero. USD -> USDC conversion is NOT automatable on this
   * account (v3 `convert/quote` rejects the pair, `buys`/`trades` 404, and `USDC-USD` is not a
   * supported product), so the only defence is to surface the stranded balance loudly.
   * A $490 deposit sat as cash for two weeks exactly this way.
   */
  getUsdBalanceCents(): Promise<number>;
  transferUsdcCents(params: {
    toAddress: string;
    cents: number;
    idempotencyKey: string;
    /** Coinbase's transfer id is returned immediately; `onchainHash` only once broadcast. */
  }): Promise<{ transactionHash: string; onchainHash?: string }>;
}

interface V2Account {
  id: string;
  name?: string;
  currency?: { code?: string };
  balance?: { amount?: string; currency?: string };
}

/**
 * Convert a Coinbase decimal amount string ("123.456789") to integer cents, flooring.
 *
 * Deliberately string-based: `parseFloat('0.29') * 100` is 28.999999999999996, which floors to 28
 * and would silently under-report the float by a cent on many values.
 */
export function decimalToCents(amount: string): number {
  const trimmed = amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new CoinbaseTreasuryError(
      `unparseable Coinbase balance amount "${amount}"`,
      'coinbase_treasury_bad_amount_format'
    );
  }
  const negative = trimmed.startsWith('-');
  const [whole, fraction = ''] = trimmed.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  return negative ? -cents : cents;
}

/** Convert integer cents to the decimal string Coinbase expects on a send. */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function createCoinbaseTreasury(
  config: CoinbaseTreasuryConfig = requireConfig()
): CoinbaseTreasury {
  const credentials: CoinbaseCredentials = {
    apiKeyId: config.apiKeyId,
    apiKeySecret: config.apiKeySecret,
  };

  async function findAccount(currencyCode: string): Promise<V2Account | undefined> {
    const body = await coinbaseRequest<{ data?: V2Account[] }>(
      credentials,
      'GET',
      '/v2/accounts?limit=100'
    );
    return (body.data ?? []).find((account) => account.currency?.code === currencyCode);
  }

  async function findUsdcAccount(): Promise<V2Account | undefined> {
    return findAccount('USDC');
  }

  return {
    async getUsdcBalanceCents() {
      const account = await findUsdcAccount();
      // No USDC wallet yet is a legitimate zero, not an error — Coinbase creates the wallet on the
      // first USDC buy or receive.
      if (account?.balance?.amount === undefined) return 0;
      return decimalToCents(account.balance.amount);
    },

    async getUsdBalanceCents() {
      const account = await findAccount('USD');
      if (account?.balance?.amount === undefined) return 0;
      return decimalToCents(account.balance.amount);
    },

    async transferUsdcCents({ toAddress, cents, idempotencyKey }) {
      if (!Number.isInteger(cents) || cents <= 0) {
        throw new CoinbaseTreasuryError(
          'transfer amount must be a positive integer number of cents',
          'coinbase_treasury_bad_amount'
        );
      }
      if (cents < MIN_SEND_CENTS) {
        throw new CoinbaseTreasuryError(
          `Coinbase will not send less than ${MIN_SEND_CENTS} cents (1 USDC); got ${cents}`,
          'coinbase_treasury_below_minimum'
        );
      }
      // Fail fast and locally rather than discovering this as a provider 400 mid-send.
      if (!UUID_PATTERN.test(idempotencyKey)) {
        throw new CoinbaseTreasuryError(
          `Coinbase requires a bare UUID for idem; got "${idempotencyKey}"`,
          'coinbase_treasury_bad_idempotency_key'
        );
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) {
        throw new CoinbaseTreasuryError(
          `refusing to transfer to malformed address "${toAddress}"`,
          'coinbase_treasury_bad_address'
        );
      }
      const account = await findUsdcAccount();
      if (account === undefined) {
        throw new CoinbaseTreasuryError(
          'Coinbase account has no USDC wallet to send from',
          'coinbase_treasury_no_usdc_wallet'
        );
      }

      log.info('Sending USDC from Coinbase treasury', {
        to: toAddress,
        cents,
        network: config.network,
        idempotency_key: idempotencyKey,
      });
      try {
        const body = await coinbaseRequest<{ data?: { id?: string; network?: { hash?: string } } }>(
          credentials,
          'POST',
          `/v2/accounts/${account.id}/transactions`,
          {
            type: 'send',
            to: toAddress,
            amount: centsToDecimal(cents),
            currency: 'USDC',
            network: NETWORK_IDS[config.network],
            // Provider-side dedup: replaying this key returns the original transaction.
            idem: idempotencyKey,
          }
        );
        // Coinbase returns its internal transfer id immediately; the onchain hash appears on a
        // later read once the send is broadcast. Keep BOTH and never present the id as a hash —
        // an explorer link built from the id 404s and looks like a lost transfer.
        const onchainHash = body.data?.network?.hash;
        const transactionHash = onchainHash ?? body.data?.id;
        if (transactionHash === undefined) {
          throw new CoinbaseTreasuryError(
            'Coinbase send returned no transaction hash or id',
            'coinbase_treasury_no_tx_reference',
            true
          );
        }
        log.info('Coinbase treasury transfer accepted', {
          transaction_hash: transactionHash,
          onchain_hash: onchainHash,
          cents,
        });
        return { transactionHash, ...(onchainHash === undefined ? {} : { onchainHash }) };
      } catch (error) {
        if (error instanceof CoinbaseTreasuryError) throw error;
        const possiblySent = error instanceof CoinbaseApiError ? error.possiblySent : true;
        throw new CoinbaseTreasuryError(
          `Coinbase treasury transfer failed: ${error instanceof Error ? error.message : String(error)}`,
          'coinbase_treasury_transfer_failed',
          possiblySent
        );
      }
    },
  };
}

function requireConfig(): CoinbaseTreasuryConfig {
  const config = loadCoinbaseTreasuryConfig();
  if (config === undefined) {
    throw new CoinbaseTreasuryError(
      'Coinbase treasury is not configured (need COINBASE_TREASURY_API_KEY_ID/_SECRET)',
      'coinbase_treasury_unconfigured'
    );
  }
  return config;
}
