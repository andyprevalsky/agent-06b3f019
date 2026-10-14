/** Lantern's official saved OAuth connection and credential envelope. */
import { createPublicKey } from './crypto';
import { decryptCredentialEnvelope } from './claudeCredentials';
import { encryptPasswordForStorage } from './credentialEnvelope';

export interface LanternConnection {
  apiUrl: string;
  token: string;
  refreshToken: string;
  expiresAt: number;
  connectionId: string;
}

export class LanternCredentialError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details?: { retryAfterSeconds: number }
  ) {
    super(code);
  }
}

export function allowedLanternOrigin(): string {
  const configured = process.env.LANTERN_PEOPLE_API_ORIGIN ?? 'https://people.lantern.md';
  try {
    const url = new URL(configured);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
    ) {
      throw new Error('invalid');
    }
    return url.origin;
  } catch {
    throw new LanternCredentialError(503, 'LANTERN_SERVER_CONFIGURATION');
  }
}

export function validateLanternConnection(value: unknown): LanternConnection {
  if (value === null || typeof value !== 'object')
    throw new LanternCredentialError(400, 'INVALID_LANTERN_CONNECTION');
  const input = value as Record<string, unknown>;
  if (
    input.apiUrl !== allowedLanternOrigin() ||
    typeof input.token !== 'string' ||
    !/^[\x21-\x7e]{8,4096}$/.test(input.token) ||
    ['people-demo-local', 'people-demo-operator'].includes(input.token) ||
    typeof input.refreshToken !== 'string' ||
    !/^lantern_rt_[-_A-Za-z0-9]{1,4096}$/.test(input.refreshToken) ||
    typeof input.expiresAt !== 'number' ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= 0 ||
    typeof input.connectionId !== 'string' ||
    !/^grant_[a-zA-Z0-9]{1,200}$/.test(input.connectionId)
  ) {
    throw new LanternCredentialError(400, 'INVALID_LANTERN_CONNECTION');
  }
  return {
    apiUrl: input.apiUrl,
    token: input.token,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    connectionId: input.connectionId,
  };
}

function privateKey(): string {
  const key = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!key) throw new LanternCredentialError(503, 'LANTERN_SERVER_CONFIGURATION');
  return key;
}

export function decodeLanternConnection(encrypted: unknown): LanternConnection {
  if (typeof encrypted !== 'string' || encrypted.length > 32768)
    throw new LanternCredentialError(400, 'INVALID_LANTERN_ENVELOPE');
  try {
    const envelope = JSON.parse(Buffer.from(encrypted, 'base64').toString()) as Record<
      string,
      unknown
    >;
    if (
      envelope?.version !== 1 ||
      ['encrypted_aes_key', 'iv', 'ciphertext'].some((key) => typeof envelope[key] !== 'string')
    ) {
      throw new Error('invalid');
    }
  } catch {
    throw new LanternCredentialError(400, 'INVALID_LANTERN_ENVELOPE');
  }
  const plaintext = decryptCredentialEnvelope(encrypted, privateKey());
  if (plaintext === null) throw new LanternCredentialError(400, 'INVALID_LANTERN_ENVELOPE');
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    throw new LanternCredentialError(400, 'INVALID_LANTERN_CONNECTION');
  }
  return validateLanternConnection(value);
}

export function encodeLanternConnection(connection: LanternConnection): string {
  try {
    const publicKey = createPublicKey(Buffer.from(privateKey(), 'base64').toString())
      .export({ type: 'spki', format: 'pem' })
      .toString();
    return encryptPasswordForStorage(JSON.stringify(connection), publicKey);
  } catch {
    throw new LanternCredentialError(503, 'LANTERN_SERVER_CONFIGURATION');
  }
}

export async function checkLanternConnection(connection: LanternConnection): Promise<void> {
  try {
    const response = await fetch(`${connection.apiUrl}/v1/operations/connection_check`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const result = (await response.json()) as { ok?: unknown; data?: unknown };
    const data = result?.data as
      { connected?: unknown; ready?: unknown; workspace?: { id?: unknown } } | undefined;
    if (
      !response.ok ||
      result?.ok !== true ||
      data?.connected !== true ||
      data.ready !== true ||
      typeof data.workspace?.id !== 'string' ||
      data.workspace.id.trim() === ''
    )
      throw new Error('invalid');
  } catch {
    throw new LanternCredentialError(400, 'LANTERN_CONNECTION_CHECK_FAILED');
  }
}

export async function refreshLanternConnection(
  connection: LanternConnection
): Promise<LanternConnection> {
  try {
    const response = await fetch(`${connection.apiUrl}/oauth/token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'lantern-cli',
        refresh_token: connection.refreshToken,
        resource: `${connection.apiUrl}/mcp`,
      }),
    });
    const value = (await response.json()) as Record<string, unknown>;
    if (
      !response.ok ||
      value.connection_id !== connection.connectionId ||
      typeof value.expires_in !== 'number' ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 30 ||
      value.refresh_token === connection.refreshToken
    )
      throw new Error('invalid');
    return validateLanternConnection({
      apiUrl: connection.apiUrl,
      token: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: Math.floor(Date.now() + value.expires_in * 1000),
      connectionId: value.connection_id,
    });
  } catch {
    throw new LanternCredentialError(409, 'LANTERN_RECONNECT_REQUIRED');
  }
}
