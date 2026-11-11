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
  /** Who holds the phone right now (may be another agent while this lease waits). */
  holder?: IPhoneDeviceHolder | null;
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

/* ── Account connection + device view (no lease, no queue) ───────────────── */

export type IPhoneSetupStepStatus = 'pending' | 'in_progress' | 'done' | 'failed';
export interface IPhoneSetupStep {
  key: string;
  label: string;
  status: IPhoneSetupStepStatus;
}
export interface IPhoneSetupProgress {
  steps: IPhoneSetupStep[];
}
export interface IPhoneConnection {
  enabled: boolean;
  accessRequested: boolean;
  configured: boolean;
  status: 'not_connected' | 'setting_up' | 'ready' | 'needs_reauth';
  setupAgentId: string | null;
  connectionRevision: number;
  /** Ordered critical setup steps; null when no setup has started. */
  setupProgress: IPhoneSetupProgress | null;
  setupTaskId: string | null;
}
const STEP_STATUSES: readonly string[] = ['pending', 'in_progress', 'done', 'failed'];

/** Additive field: anything malformed reads as "no progress yet", never as readiness. */
function setupProgress(value: unknown): IPhoneSetupProgress | null {
  if (value === null || typeof value !== 'object') return null;
  const steps = (value as Record<string, unknown>).steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const parsed: IPhoneSetupStep[] = [];
  for (const step of steps) {
    if (step === null || typeof step !== 'object') return null;
    const row = step as Record<string, unknown>;
    if (
      typeof row.key !== 'string' ||
      typeof row.label !== 'string' ||
      !STEP_STATUSES.includes(String(row.status))
    )
      return null;
    parsed.push({ key: row.key, label: row.label, status: row.status as IPhoneSetupStepStatus });
  }
  return { steps: parsed };
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
  return {
    enabled: row.enabled,
    accessRequested: row.accessRequested === true,
    configured: row.configured,
    status: row.status as IPhoneConnection['status'],
    setupAgentId: row.setupAgentId as string | null,
    connectionRevision: Number(row.connectionRevision),
    setupProgress: setupProgress(row.setupProgress),
    setupTaskId:
      typeof row.setupTaskId === 'string' && row.setupTaskId.length > 0 ? row.setupTaskId : null,
  };
}

async function connectionRequest(
  signal: AbortSignal,
  body?: { requestKey: string; expectedRevision: number },
) {
  return bounded(signal, async (owned) => {
    const response = await fetch(
      `${API_BASE_WITH_PATH}/iphone/${body === undefined ? 'connection' : 'connect'}`,
      {
        headers: getAuthHeaders(),
        cache: 'no-store',
        signal: owned,
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      },
    );
    if (!response.ok) throw new Error('iPhone connection request failed');
    return connection(await response.json());
  });
}
export const readIPhoneConnection = (signal: AbortSignal) => connectionRequest(signal);
export const connectIPhone = (requestKey: string, expectedRevision: number, signal: AbortSignal) =>
  connectionRequest(signal, { requestKey, expectedRevision });

export async function requestIPhoneAccess(signal: AbortSignal): Promise<IPhoneConnection> {
  return bounded(signal, async (owned) =>
    connection(await (await request('request-access', owned, {})).json()),
  );
}

export type IPhoneProviderState = 'IDLE' | 'STARTING' | 'READY' | 'CLOSING';
export interface IPhoneDeviceHolder {
  agentId: string;
  leaseId: string;
  controlOwner: 'agent' | 'user';
  since: string;
}
export interface IPhoneDeviceWaiter {
  agentId: string;
  leaseId: string;
  position: number;
  queueDeadlineAt: string | null;
}
/** Read-only device observation: never allocates a lease or joins the queue. */
export interface IPhoneDevice {
  enabled: boolean;
  setupState: string;
  providerState: IPhoneProviderState;
  holder: IPhoneDeviceHolder | null;
  waiting: IPhoneDeviceWaiter[];
}
const PROVIDER_STATES: readonly string[] = ['IDLE', 'STARTING', 'READY', 'CLOSING'];

function device(value: unknown): IPhoneDevice {
  if (value === null || typeof value !== 'object') throw new Error('Invalid iPhone device');
  const row = value as Record<string, unknown>;
  if (typeof row.enabled !== 'boolean' || !PROVIDER_STATES.includes(String(row.providerState)))
    throw new Error('Invalid iPhone device');
  const holder = row.holder as Record<string, unknown> | null | undefined;
  return {
    enabled: row.enabled,
    setupState: typeof row.setupState === 'string' ? row.setupState : 'not_connected',
    providerState: row.providerState as IPhoneProviderState,
    holder:
      holder && typeof holder === 'object' && typeof holder.agentId === 'string'
        ? {
            agentId: holder.agentId,
            leaseId: typeof holder.leaseId === 'string' ? holder.leaseId : '',
            controlOwner: holder.controlOwner === 'user' ? 'user' : 'agent',
            since: typeof holder.since === 'string' ? holder.since : '',
          }
        : null,
    waiting: Array.isArray(row.waiting) ? (row.waiting as IPhoneDeviceWaiter[]) : [],
  };
}
export async function readIPhoneDevice(signal: AbortSignal): Promise<IPhoneDevice> {
  return bounded(signal, async (owned) => device(await (await request('device', owned)).json()));
}

/** A live frame, or why none is visible (provider state, `busy` or `private`). */
export type IPhoneDeviceFrame =
  | { kind: 'frame'; blob: Blob }
  | { kind: 'unavailable'; state: IPhoneProviderState | 'busy' | 'private' };

export async function readIPhoneDeviceFrame(signal: AbortSignal): Promise<IPhoneDeviceFrame> {
  return bounded(signal, async (owned) => {
    const response = await fetch(`${API_BASE_WITH_PATH}/iphone/device/frame`, {
      headers: getAuthHeaders(),
      signal: owned,
      cache: 'no-store',
    });
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as { state?: unknown } | null;
      const state = String(body?.state ?? 'busy');
      return {
        kind: 'unavailable',
        state: (PROVIDER_STATES.includes(state) || state === 'private' ? state : 'busy') as
          IPhoneProviderState | 'busy' | 'private',
      };
    }
    if (!response.ok) throw new PhoneRequestError(response.status);
    if (response.headers.get('Content-Type')?.split(';')[0] !== 'image/png')
      throw new Error('Phone frame unavailable');
    return { kind: 'frame', blob: await response.blob() };
  });
}
