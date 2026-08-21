/**
 * Brex Payments API — the fiat leg that replenishes the Coinbase USDC float.
 *
 *   Brex cash ──wire/ACH──▶ Coinbase ──buy USDC──▶ Coinbase USDC ──send──▶ AgentCard org wallet
 *   └────────── this module ──────────┘            └──── providers/coinbase/treasury.ts ────┘
 *
 * This leg is DELIBERATELY NOT on the purchase hot path. A bank transfer settles in 1-3 business
 * days, so it can only keep the float topped up over time; the synchronous org-wallet refill is
 * the Coinbase→org-wallet hop. Run from cron.
 *
 * The rail (`processing_type`) is configuration, never a hardcoded default — see `BrexConfig`.
 *
 * Request schema was discovered empirically against the live API (every field below is rejected as
 * "Missing argument" if omitted):
 *   counterparty.payment_instrument_id, amount{amount,currency}, description, external_memo
 */

import { createLogger } from '../logger';

const log = createLogger('BrexTreasury');

const DEFAULT_BASE_URL = 'https://platform.brexapis.com';

export class BrexApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** True when the failure may have reached Brex after a transfer was accepted. */
  readonly possiblySent: boolean;

  constructor(message: string, status: number, code: string, possiblySent = false) {
    super(message);
    this.name = 'BrexApiError';
    this.status = status;
    this.code = code;
    this.possiblySent = possiblySent;
  }
}

/** Rails Brex accepts on `POST /v1/transfers`. */
export const BREX_PROCESSING_TYPES = ['ACH', 'WIRE', 'SAME_DAY_ACH', 'CHECK'] as const;
export type BrexProcessingType = (typeof BREX_PROCESSING_TYPES)[number];

export interface BrexConfig {
  apiToken: string;
  baseUrl: string;
  /** Brex payment instrument representing the Coinbase deposit account. */
  coinbaseCounterpartyId?: string;
  /** Cash account the transfer draws from. Defaults to the highest-balance account. */
  originatingAccountId?: string;
  /**
   * Rail to send on. NOT hardcoded: Coinbase's deposit page for this account states
   * "Wire transfers only — please do not send funds via ACH", while a Brex payment instrument is
   * created as a specific type. Sending on the wrong rail risks rejection or a misapplied deposit,
   * so the rail is explicit config and is cross-checked against the instrument before every send.
   */
  processingType: BrexProcessingType;
}

export interface BrexCashAccount {
  id: string;
  name: string;
  status: string;
  availableCents: number;
  currentCents: number;
}

export interface BrexTreasury {
  listCashAccounts(): Promise<BrexCashAccount[]>;
  /** Total available across ACTIVE accounts, in cents. */
  getAvailableCents(): Promise<number>;
  /** Rail the configured Coinbase payment instrument was created for, e.g. "ACH". */
  getCounterpartyRail(): Promise<string | undefined>;
  transferToCoinbase(params: {
    cents: number;
    idempotencyKey: string;
    description: string;
  }): Promise<{ transferId: string }>;
}

/**
 * A Brex payment instrument is created for one rail. Sending WIRE money through an ACH-typed
 * instrument (or vice versa) is the kind of mistake that is invisible until funds bounce or land
 * unattributed, so the two are compared before every transfer.
 *
 * SAME_DAY_ACH is an ACH-family rail and is compatible with an ACH instrument.
 */
export function railsAreCompatible(
  instrumentType: string,
  processingType: BrexProcessingType
): boolean {
  // Brex names the INSTRUMENT and the TRANSFER RAIL differently: an instrument is
  // `DOMESTIC_WIRE` (or `INTERNATIONAL_WIRE`) while a transfer's processing_type is `WIRE`.
  // Comparing the raw strings would reject a perfectly good wire instrument, so normalise both
  // to a family first. SAME_DAY_ACH is likewise an ACH-family rail.
  const family = (value: string): string => {
    const upper = value.toUpperCase();
    if (upper === 'SAME_DAY_ACH') return 'ACH';
    if (upper.endsWith('WIRE')) return 'WIRE';
    return upper;
  };
  return family(instrumentType) === family(processingType);
}

export function brexProcessingTypeFromEnvironment(): BrexProcessingType {
  const raw = process.env.BREX_TRANSFER_PROCESSING_TYPE?.trim();
  // Default WIRE: Coinbase's deposit instructions for this account say wire only. Defaulting to
  // ACH would silently pick the rail Coinbase explicitly warns against.
  if (raw === undefined || raw === '') return 'WIRE';
  if (!(BREX_PROCESSING_TYPES as readonly string[]).includes(raw)) {
    throw new Error(
      `BREX_TRANSFER_PROCESSING_TYPE must be one of ${BREX_PROCESSING_TYPES.join(', ')} (got "${raw}")`
    );
  }
  return raw as BrexProcessingType;
}

export function loadBrexConfig(): BrexConfig | undefined {
  const apiToken = process.env.BREX_API_TOKEN?.trim();
  if (apiToken === undefined || apiToken === '') return undefined;
  return {
    apiToken,
    baseUrl: process.env.BREX_API_BASE_URL?.trim() || DEFAULT_BASE_URL,
    processingType: brexProcessingTypeFromEnvironment(),
    ...(process.env.BREX_COINBASE_COUNTERPARTY_ID?.trim()
      ? { coinbaseCounterpartyId: process.env.BREX_COINBASE_COUNTERPARTY_ID.trim() }
      : {}),
    ...(process.env.BREX_ORIGINATING_ACCOUNT_ID?.trim()
      ? { originatingAccountId: process.env.BREX_ORIGINATING_ACCOUNT_ID.trim() }
      : {}),
  };
}

interface BrexMoney {
  amount?: number;
  currency?: string;
}

interface BrexCashAccountResponse {
  id: string;
  name?: string;
  status?: string;
  available_balance?: BrexMoney;
  current_balance?: BrexMoney;
}

export function createBrexTreasury(config: BrexConfig): BrexTreasury {
  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey !== undefined ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      throw new BrexApiError(
        `Brex ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
        'brex_transport_error',
        method === 'POST'
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    const parsed: unknown = text === '' ? {} : JSON.parse(text);
    if (!response.ok) {
      const detail = (parsed as { message?: string }).message ?? text.slice(0, 200);
      throw new BrexApiError(
        `Brex ${method} ${path} -> ${response.status}: ${detail}`,
        response.status,
        `brex_http_${response.status}`,
        // Brex honours Idempotency-Key, so a 5xx replay is safe; still flag it for the caller.
        method === 'POST' && response.status >= 500
      );
    }
    return parsed as T;
  }

  async function listCashAccounts(): Promise<BrexCashAccount[]> {
    const body = await request<{ items?: BrexCashAccountResponse[] }>('GET', '/v2/accounts/cash');
    return (body.items ?? []).map((item) => ({
      id: item.id,
      name: item.name ?? 'unknown',
      status: item.status ?? 'UNKNOWN',
      availableCents: item.available_balance?.amount ?? 0,
      currentCents: item.current_balance?.amount ?? 0,
    }));
  }

  async function getCounterpartyRail(): Promise<string | undefined> {
    if (config.coinbaseCounterpartyId === undefined) return undefined;
    const body = await request<{
      items?: Array<{
        payment_accounts?: Array<{ details?: { type?: string; payment_instrument_id?: string } }>;
      }>;
    }>('GET', '/v1/vendors?limit=100');
    for (const vendor of body.items ?? []) {
      for (const account of vendor.payment_accounts ?? []) {
        if (account.details?.payment_instrument_id === config.coinbaseCounterpartyId) {
          return account.details.type;
        }
      }
    }
    return undefined;
  }

  return {
    listCashAccounts,
    getCounterpartyRail,

    async getAvailableCents() {
      const accounts = await listCashAccounts();
      return accounts
        .filter((account) => account.status === 'ACTIVE')
        .reduce((total, account) => total + Math.max(0, account.availableCents), 0);
    },

    async transferToCoinbase({ cents, idempotencyKey, description }) {
      if (config.coinbaseCounterpartyId === undefined) {
        throw new BrexApiError(
          'BREX_COINBASE_COUNTERPARTY_ID is not set; add Coinbase as a Brex payment instrument first',
          0,
          'brex_no_coinbase_counterparty'
        );
      }
      if (!Number.isInteger(cents) || cents <= 0) {
        throw new BrexApiError(
          'transfer amount must be a positive integer number of cents',
          0,
          'brex_bad_amount'
        );
      }

      // Fail closed on a rail mismatch. Coinbase's deposit page for this account says wire only;
      // pushing ACH at it (or wiring through an ACH instrument) can bounce or land unattributed.
      const instrumentRail = await getCounterpartyRail();
      if (instrumentRail === undefined) {
        throw new BrexApiError(
          `BREX_COINBASE_COUNTERPARTY_ID ${config.coinbaseCounterpartyId} matches no Brex payment instrument`,
          0,
          'brex_counterparty_not_found'
        );
      }
      if (!railsAreCompatible(instrumentRail, config.processingType)) {
        throw new BrexApiError(
          `Brex payment instrument is ${instrumentRail} but BREX_TRANSFER_PROCESSING_TYPE is ` +
            `${config.processingType}. Recreate the instrument on the intended rail, or change ` +
            `the env var — refusing to send on a mismatched rail.`,
          0,
          'brex_rail_mismatch'
        );
      }

      // Draw from the explicitly configured account, else the one with the most available funds.
      let originatingAccountId = config.originatingAccountId;
      if (originatingAccountId === undefined) {
        const accounts = (await listCashAccounts())
          .filter((account) => account.status === 'ACTIVE')
          .sort((a, b) => b.availableCents - a.availableCents);
        if (accounts.length === 0 || accounts[0].availableCents < cents) {
          throw new BrexApiError(
            `no Brex cash account has ${cents} cents available`,
            0,
            'brex_insufficient_funds'
          );
        }
        originatingAccountId = accounts[0].id;
      }

      log.info('Initiating Brex transfer to Coinbase', {
        cents,
        originating_account_id: originatingAccountId,
        idempotency_key: idempotencyKey,
      });
      const created = await request<{ id?: string }>(
        'POST',
        '/v1/transfers',
        {
          counterparty: { type: 'VENDOR', payment_instrument_id: config.coinbaseCounterpartyId },
          amount: { amount: cents, currency: 'USD' },
          description,
          external_memo: description,
          originating_account: { type: 'BREX_CASH', id: originatingAccountId },
          processing_type: config.processingType,
        },
        idempotencyKey
      );
      if (created.id === undefined) {
        throw new BrexApiError('Brex transfer returned no id', 502, 'brex_no_transfer_id', true);
      }
      log.info('Brex transfer accepted', { transfer_id: created.id, cents });
      return { transferId: created.id };
    },
  };
}
