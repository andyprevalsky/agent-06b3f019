/** Task-owned phone API. User JWT only; no provider viewer or control grant crosses this client. */
import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface PhoneLease {
  id: string;
  agentId: string;
  browserTaskId: string;
  status: 'ACTIVE' | 'WAITING' | 'RELEASED' | 'EXPIRED' | 'CANCELLED';
  queuePosition: number | null;
  queueDeadlineAt: string | null;
  leaseExpiresAt: string | null;
  controlOwner: 'user' | 'agent';
  attentionRequestId: string | null;
  revision: number;
}
export interface PhoneOperation {
  id: string;
  cursor: number;
  operation: string;
  status: 'CONNECTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  errorCode: string | null;
  result: unknown;
}
/** Safe setup observation only. Readiness reflects backend-verified configuration, not carrier SMS or external forwarding. */
export interface PhoneSetupStatus {
  required: boolean;
  state:
    | 'not_started'
    | 'in_progress'
    | 'awaiting_user'
    | 'verifying'
    | 'ready'
    | 'blocked'
    | 'deferred';
  attemptId: string | null;
  revision: number;
  profileRevision: number;
  reasonCode?: string;
  lastVerifiedAt?: string;
  lastRequest?: unknown;
}
export interface PhoneInteraction {
  setup?: PhoneSetupStatus;
  lease: PhoneLease | null;
  cursor: number;
  lastOperation: PhoneOperation | null;
  pendingOperation: PhoneOperation | null;
}
export interface PhoneBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  id?: number;
}
export class PhoneRequestError extends Error {
  constructor(public readonly status: number) {
    super(`Phone request failed (${status})`);
  }
}
async function request(path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
  const response = await fetch(`${API_BASE_WITH_PATH}/iphone/${path}`, {
    headers: getAuthHeaders(),
    signal,
    cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new PhoneRequestError(response.status);
  return response;
}
async function bounded<T>(
  signal: AbortSignal,
  read: (owned: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const deadline = setTimeout(abort, 15000);
  try {
    return await read(controller.signal);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
  }
}
const leasePath = (id: string) => `leases/${encodeURIComponent(id)}`;
export async function readPhoneInteraction(
  taskId: string,
  signal: AbortSignal,
): Promise<PhoneInteraction> {
  return bounded(signal, async (owned) =>
    (await request(`interactions/${encodeURIComponent(taskId)}`, owned)).json(),
  );
}
export async function readPhoneFrame(id: string, signal: AbortSignal): Promise<Blob> {
  return bounded(signal, async (owned) => {
    const response = await request(`${leasePath(id)}/frame`, owned);
    if (response.headers.get('Content-Type')?.split(';')[0] !== 'image/png')
      throw new Error('Phone frame unavailable');
    return response.blob();
  });
}
export async function controlPhone(
  id: string,
  mode: 'user' | 'agent',
  signal: AbortSignal,
): Promise<{ lease: PhoneLease }> {
  return bounded(signal, async (owned) =>
    (await request(`${leasePath(id)}/control`, owned, { mode })).json(),
  );
}
export async function performPhoneOperation(
  id: string,
  command: {
    operationId: string;
    operation: string;
    args: Record<string, unknown>;
    expectedCursor: number;
    attentionRequestId?: string;
  },
  signal: AbortSignal,
): Promise<{ operation: PhoneOperation }> {
  return bounded(signal, async (owned) =>
    (await request(`${leasePath(id)}/operations`, owned, command)).json(),
  );
}
export async function readPhoneOperation(
  id: string,
  operationId: string,
  signal: AbortSignal,
): Promise<{ operation: PhoneOperation }> {
  return bounded(signal, async (owned) =>
    (await request(`${leasePath(id)}/operations/${encodeURIComponent(operationId)}`, owned)).json(),
  );
}
