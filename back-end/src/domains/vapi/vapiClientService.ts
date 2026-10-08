import { VAPI_BASE_URL, VAPI_PRIVATE_KEY } from './config';
import { createLogger } from '../../providers/logger';

const log = createLogger('Vapi');

export class VapiNotConfiguredError extends Error {
  constructor() {
    super('Vapi not configured');
    this.name = 'VapiNotConfiguredError';
  }
}

export class VapiApiError extends Error {
  public statusCode: number;
  public details: string;

  constructor(statusCode: number, details: string) {
    super(`Vapi API error (${statusCode})`);
    this.name = 'VapiApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function getVapiPrivateKey(): string {
  const vapiPrivateKey = VAPI_PRIVATE_KEY;
  if (vapiPrivateKey === undefined || vapiPrivateKey === '') {
    log.error('VAPI_PRIVATE_KEY not configured');
    throw new VapiNotConfiguredError();
  }
  return vapiPrivateKey;
}

export async function fetchVapi(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new VapiApiError(504, 'VAPI request timed out');
    }
    throw err;
  }
}

/** POST /call. Returns the raw response so callers own side-effect bookkeeping. */
export async function postVapiCall(body: string): Promise<Response> {
  return fetchVapi(
    `${VAPI_BASE_URL}/call`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getVapiPrivateKey()}`,
        'Content-Type': 'application/json',
      },
      body,
    },
    45_000
  );
}

/** GET /call/:id, throwing {@link VapiApiError} on a non-2xx response. */
export async function getVapiCall(callId: string): Promise<Record<string, unknown>> {
  const response = await fetchVapi(
    `${VAPI_BASE_URL}/call/${callId}`,
    { method: 'GET', headers: { Authorization: `Bearer ${getVapiPrivateKey()}` } },
    15_000
  );
  if (!response.ok) {
    throw new VapiApiError(response.status, await response.text());
  }
  return (await response.json()) as Record<string, unknown>;
}
