import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  CountryCode,
  Products,
  LinkTokenCreateRequest,
  type ItemPublicTokenExchangeResponse,
  type ItemRemoveResponse,
  type AccountsGetResponse,
  type LinkTokenCreateResponse,
} from 'plaid';
import { createLogger } from './logger';

const log = createLogger('Plaid');

const PLAID_ENV = (process.env.PLAID_ENV ?? 'sandbox').toLowerCase();
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET =
  PLAID_ENV === 'production'
    ? process.env.PLAID_PRODUCTION_SECRET
    : process.env.PLAID_SANDBOX_SECRET;

const PLAID_BASE_PATHS: Record<string, string> = {
  sandbox: PlaidEnvironments.sandbox,
  production: PlaidEnvironments.production,
};

function getBasePath(): string {
  const path = PLAID_BASE_PATHS[PLAID_ENV];
  if (!path) {
    throw new Error(`Unknown PLAID_ENV='${PLAID_ENV}'; expected 'sandbox' or 'production'`);
  }
  return path;
}

let cachedClient: PlaidApi | null = null;

/**
 * Get a singleton Plaid API client configured from environment variables.
 * Throws if `PLAID_CLIENT_ID` or the env-appropriate secret is missing.
 */
export function getPlaidClient(): PlaidApi {
  if (cachedClient) return cachedClient;

  if (!PLAID_CLIENT_ID) {
    throw new Error('PLAID_CLIENT_ID is not configured');
  }
  if (!PLAID_SECRET) {
    throw new Error(
      `PLAID_${PLAID_ENV === 'production' ? 'PRODUCTION' : 'SANDBOX'}_SECRET is not configured`
    );
  }

  const config = new Configuration({
    basePath: getBasePath(),
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET': PLAID_SECRET,
      },
    },
  });

  cachedClient = new PlaidApi(config);
  log.info('Plaid client initialized', { env: PLAID_ENV });
  return cachedClient;
}

/**
 * Test-only: reset the cached client so a new one is instantiated on next
 * call (used by blackbox tests that mock the plaid SDK at the module level).
 */
export function resetPlaidClientForTests(): void {
  cachedClient = null;
}

/**
 * Broad product set used outside production. Sandbox can create Link tokens for
 * all of these, which keeps local coverage representative of the intended
 * integration surface.
 */
export const PLAID_SANDBOX_PRODUCTS: Products[] = [
  Products.Auth,
  Products.Transactions,
  Products.Identity,
  Products.Investments,
  Products.Liabilities,
];

/**
 * Products currently enabled on the Plaid production account. Requesting
 * Auth/Identity before Plaid approves them causes /link/token/create to fail
 * with INVALID_PRODUCT, so they must stay out of the production Link token.
 */
export const PLAID_PRODUCTION_PRODUCTS: Products[] = [
  Products.Transactions,
  Products.Investments,
  Products.Liabilities,
];

export const PLAID_DEFAULT_PRODUCTS: Products[] =
  PLAID_ENV === 'production' ? PLAID_PRODUCTION_PRODUCTS : PLAID_SANDBOX_PRODUCTS;

/**
 * Optional products: requested as `optional_products` in Link so that a
 * connection succeeds even if the institution does not support them.
 */
export const PLAID_OPTIONAL_PRODUCTS: Products[] = [];

export const PLAID_DEFAULT_COUNTRY_CODES: CountryCode[] = [CountryCode.Us];

/** Plaid OAuth redirect URI used for OAuth-enabled US banks. */
export function getPlaidRedirectUri(): string | undefined {
  return process.env.PLAID_REDIRECT_URI;
}

export type CreateLinkTokenInput = {
  /** Stable per-end-user identifier (Rose Labs user id). */
  clientUserId: string;
  /** Optional product overrides. Defaults to PLAID_DEFAULT_PRODUCTS. */
  products?: Products[];
  /** Optional OAuth redirect URI override. */
  redirectUri?: string;
  /** Webhook URL Plaid will call for ITEM/TRANSACTIONS events. */
  webhook?: string;
};

export async function createLinkToken(
  input: CreateLinkTokenInput
): Promise<LinkTokenCreateResponse> {
  const client = getPlaidClient();
  const products = input.products ?? PLAID_DEFAULT_PRODUCTS;
  const redirectUri = input.redirectUri ?? getPlaidRedirectUri();

  const request: LinkTokenCreateRequest = {
    user: { client_user_id: input.clientUserId },
    client_name: 'Rose Labs',
    products,
    language: 'en',
    country_codes: PLAID_DEFAULT_COUNTRY_CODES,
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    ...(input.webhook ? { webhook: input.webhook } : {}),
  };

  const response = await client.linkTokenCreate(request);
  return response.data;
}

export async function exchangePublicToken(
  publicToken: string
): Promise<ItemPublicTokenExchangeResponse> {
  const client = getPlaidClient();
  const response = await client.itemPublicTokenExchange({ public_token: publicToken });
  return response.data;
}

export async function getAccounts(accessToken: string): Promise<AccountsGetResponse> {
  const client = getPlaidClient();
  const response = await client.accountsGet({ access_token: accessToken });
  return response.data;
}

export async function removeItem(accessToken: string): Promise<ItemRemoveResponse> {
  const client = getPlaidClient();
  const response = await client.itemRemove({ access_token: accessToken });
  return response.data;
}

/**
 * Narrow a thrown error to a Plaid API error. Plaid SDK errors expose
 * `response.data` containing `{error_code, error_message, error_type, ...}`.
 */
export interface PlaidErrorPayload {
  error_code: string;
  error_message: string;
  error_type: string;
  display_message?: string | null;
  request_id?: string;
}

export function isPlaidError(err: unknown): err is { response: { data: PlaidErrorPayload } } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    typeof (err as { response: unknown }).response === 'object' &&
    (err as { response: { data?: unknown } }).response !== null &&
    typeof (err as { response: { data?: unknown } }).response.data === 'object' &&
    (err as { response: { data: PlaidErrorPayload } }).response.data !== null &&
    'error_code' in (err as { response: { data: { error_code?: unknown } } }).response.data
  );
}

export function getPlaidEnv(): 'sandbox' | 'production' {
  return PLAID_ENV === 'production' ? 'production' : 'sandbox';
}
