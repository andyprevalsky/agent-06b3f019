/**
 * Minimal JWT-signed REST client for the Coinbase API (api.coinbase.com).
 *
 * Signs an EdDSA (Ed25519) JWT per request — the token is bound to `METHOD host/path`, so it
 * cannot be reused across endpoints.
 *
 * This talks to the **v2 API**, not v3 Advanced Trade. v2 is the surface that exposes
 * `POST /v2/accounts/{id}/transactions` with `type: "send"` — the only Coinbase endpoint that can
 * push crypto to an external onchain address. v3 has no withdrawal endpoint.
 */

import { createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { createLogger } from '../logger';

const log = createLogger('CoinbaseClient');

export const COINBASE_API_HOST = 'api.coinbase.com';

/**
 * DER prefix for a PKCS#8-wrapped Ed25519 private key. Node's `createPrivateKey` needs PKCS#8;
 * Coinbase issues a raw 64-byte key (32-byte seed || 32-byte public key), so the seed is wrapped
 * here rather than pulling in a JOSE dependency.
 *
 * The SDK ships `generateJwt` under the `@coinbase/cdp-sdk/auth` subpath export, which this repo's
 * `moduleResolution: "node"` cannot resolve. Signing here keeps the provider dependency-free.
 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Build the EdDSA JWT Coinbase expects, bound to `METHOD host/path`. */
export function buildCoinbaseJwt(
  credentials: CoinbaseCredentials,
  method: string,
  host: string,
  path: string
): string {
  const raw = Buffer.from(credentials.apiKeySecret, 'base64');
  if (raw.length !== 64 && raw.length !== 32) {
    throw new CoinbaseApiError(
      `Coinbase API key secret must be a base64 Ed25519 key (got ${raw.length} bytes)`,
      0,
      'coinbase_bad_key_format'
    );
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]),
    format: 'der',
    type: 'pkcs8',
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'EdDSA',
    kid: credentials.apiKeyId,
    typ: 'JWT',
    // Coinbase requires a unique nonce per token to prevent replay.
    nonce: randomBytes(16).toString('hex'),
  };
  const payload = {
    sub: credentials.apiKeyId,
    iss: 'cdp',
    aud: ['cdp_service'],
    nbf: issuedAt,
    exp: issuedAt + 120,
    uri: `${method} ${host}${path}`,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  // Ed25519 signs the message directly — the digest algorithm must be null.
  return `${signingInput}.${base64Url(cryptoSign(null, Buffer.from(signingInput), privateKey))}`;
}

export class CoinbaseApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** True when the failure may have reached Coinbase after a send was accepted. */
  readonly possiblySent: boolean;

  constructor(message: string, status: number, code: string, possiblySent = false) {
    super(message);
    this.name = 'CoinbaseApiError';
    this.status = status;
    this.code = code;
    this.possiblySent = possiblySent;
  }
}

export interface CoinbaseCredentials {
  apiKeyId: string;
  apiKeySecret: string;
}

function firstErrorMessage(body: unknown): string | undefined {
  const record = body as { errors?: Array<{ id?: string; message?: string }>; message?: string };
  if (Array.isArray(record?.errors) && record.errors.length > 0) {
    const first = record.errors[0];
    return [first.id, first.message].filter(Boolean).join(': ') || undefined;
  }
  return typeof record?.message === 'string' ? record.message : undefined;
}

/**
 * Issue a signed request. `path` must include the leading slash and any query string; the JWT is
 * signed over the path WITHOUT the query, which is what Coinbase expects.
 */
export async function coinbaseRequest<T>(
  credentials: CoinbaseCredentials,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  options: { timeoutMs?: number } = {}
): Promise<T> {
  const pathWithoutQuery = path.split('?')[0];
  const jwt = buildCoinbaseJwt(credentials, method, COINBASE_API_HOST, pathWithoutQuery);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetch(`https://${COINBASE_API_HOST}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    // A transport failure on a POST is ambiguous: the request may have been accepted. Only GETs
    // are safe to treat as definitely-not-applied.
    throw new CoinbaseApiError(
      `Coinbase ${method} ${pathWithoutQuery} failed: ${error instanceof Error ? error.message : String(error)}`,
      0,
      'coinbase_transport_error',
      method === 'POST'
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    const detail = firstErrorMessage(parsed) ?? text.slice(0, 200);
    // A 5xx on a send is ambiguous — Coinbase may have accepted it before failing to respond.
    const ambiguous = method === 'POST' && response.status >= 500;
    throw new CoinbaseApiError(
      `Coinbase ${method} ${pathWithoutQuery} -> ${response.status}: ${detail}`,
      response.status,
      `coinbase_http_${response.status}`,
      ambiguous
    );
  }

  log.info('Coinbase API call succeeded', {
    method,
    path: pathWithoutQuery,
    status: response.status,
  });
  return parsed as T;
}
