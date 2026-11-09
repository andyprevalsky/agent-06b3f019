import { API_BASE_WITH_PATH, getAuthHeaders } from '@/lib/api/client';

export interface IPhoneConnection {
  enabled: boolean;
  configured: boolean;
  status: 'not_connected' | 'setting_up' | 'ready' | 'needs_reauth';
  setupAgentId: string | null;
  connectionRevision: number;
}

function connection(value: unknown): IPhoneConnection {
  if (value === null || typeof value !== 'object') throw new Error('Invalid iPhone connection');
  const row = value as Record<string, unknown>;
  if (
    typeof row.enabled !== 'boolean' ||
    typeof row.configured !== 'boolean' ||
    !['not_connected', 'setting_up', 'ready', 'needs_reauth'].includes(String(row.status)) ||
    (row.setupAgentId !== null &&
      (typeof row.setupAgentId !== 'string' || row.setupAgentId.length === 0)) ||
    !Number.isSafeInteger(row.connectionRevision) ||
    Number(row.connectionRevision) < 0 ||
    (row.status === 'ready' && (!row.enabled || !row.configured))
  )
    throw new Error('Invalid iPhone connection');
  return row as unknown as IPhoneConnection;
}

async function request(
  signal: AbortSignal,
  body?: { requestKey: string; expectedRevision: number },
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 15_000);
  try {
    const response = await fetch(
      `${API_BASE_WITH_PATH}/iphone/${body === undefined ? 'connection' : 'connect'}`,
      {
        headers: getAuthHeaders(),
        cache: 'no-store',
        signal: controller.signal,
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      },
    );
    if (!response.ok) throw new Error('iPhone connection request failed');
    return connection(await response.json());
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
export const readIPhoneConnection = (signal: AbortSignal) => request(signal);
export const connectIPhone = (requestKey: string, expectedRevision: number, signal: AbortSignal) =>
  request(signal, { requestKey, expectedRevision });
