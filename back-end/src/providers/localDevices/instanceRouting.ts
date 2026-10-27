/**
 * Cross-instance routing for the local-device hub.
 *
 * A Mac's control channel, its per-session tunnel, the relay clients (worker,
 * FE) and the API calls that start/stop sessions can each land on a different
 * backend instance: Render balances WebSockets across instances at random and
 * has no sticky sessions. Live sockets cannot move, so the instance that holds
 * a Mac's control channel OWNS that device, and every other instance forwards
 * to it over the private network:
 *
 *   Mac ──control──► A (owner)          owner row  local-device-owner/<device>
 *   Mac ──tunnel───► B ──ws proxy──► A               = { token, instance, userId, sessionsRoot }
 *   worker ─relay──► C ──ws proxy──► A  relay row  local-relay-device/<task> = { deviceId }
 *   API on C ──internal ws {op}──► A    (start / stop / status)
 *
 * Rows are per device / per task (no fan-in); the owner renews its row on the
 * control-channel ping and a dead owner's row expires within a few intervals.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';
import WebSocket, { type RawData } from 'ws';
import { createLogger } from '../logger';
import {
  deleteEphemeral,
  getEphemeral,
  putEphemeral,
  releaseLease,
  renewLease,
  replaceLeaseValue,
} from '../sharedState';

const log = createLogger('LocalDevicesRouting');

export const LOCAL_DEVICE_INTERNAL_PATH = '/api/local-devices/internal';
/** Set on a proxied upgrade so the receiving instance never forwards it again. */
export const HUB_FORWARDED_HEADER = 'x-rose-hub-forwarded';
const INTERNAL_AUTH_HEADER = 'x-rose-hub-auth';

const OWNER_NAMESPACE = 'local-device-owner';
const RELAY_NAMESPACE = 'local-relay-device';
const RELAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INTERNAL_CALL_TIMEOUT_MS = 45_000;
const PROXY_PING_INTERVAL_MS = 25_000;

export interface DeviceOwnerRow {
  token: string;
  instance: string;
  userId: string;
  sessionsRoot: string | null;
}

/**
 * Base URL other instances use to reach this one. Render instances reach each
 * other on their private IPs; locally everything is loopback.
 */
export function thisInstanceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.BACKEND_INSTANCE_INTERNAL_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = env.PORT?.trim() || '3001';
  if (env.RENDER !== 'true') return `http://127.0.0.1:${port}`;
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)?.address;
  if (address === undefined) {
    // Every instance would claim the same loopback identity and routing would
    // silently degrade to single-instance behaviour.
    log.error('No private IPv4 address on Render; set BACKEND_INSTANCE_INTERNAL_URL per instance');
    return `http://127.0.0.1:${port}`;
  }
  return `http://${address}:${port}`;
}

/** Peer requests carry `<unix ms>.<hmac>`; a captured header expires within a minute. */
const INTERNAL_AUTH_WINDOW_MS = 60_000;

function internalAuth(secret: string, at: number = Date.now()): string {
  const signature = createHmac('sha256', secret)
    .update(`local-device-hub-internal:${at}`)
    .digest('hex');
  return `${at}.${signature}`;
}

/**
 * Peers call each other directly on the private network. A request that came
 * through the public load balancer carries X-Forwarded-For and is refused even
 * with a valid signature.
 */
export function internalAuthMatches(request: IncomingMessage, secret: string): boolean {
  if (request.headers['x-forwarded-for'] !== undefined) return false;
  const presented = request.headers[INTERNAL_AUTH_HEADER];
  if (typeof presented !== 'string') return false;
  const at = Number(presented.split('.')[0]);
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > INTERNAL_AUTH_WINDOW_MS) return false;
  const expected = Buffer.from(internalAuth(secret, at), 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function wasForwarded(request: IncomingMessage): boolean {
  return request.headers[HUB_FORWARDED_HEADER] === '1';
}

// ── owner + relay registry ────────────────────────────────────────────────

export async function claimDeviceOwner(
  deviceId: string,
  row: Omit<DeviceOwnerRow, 'token'>,
  ttlMs: number
): Promise<string> {
  const token = randomUUID();
  await putEphemeral(OWNER_NAMESPACE, deviceId, { token, ...row }, ttlMs);
  return token;
}

/** Rewrite this instance's owner row (e.g. the hello's sessions root) if it still owns it. */
export const updateDeviceOwner = (deviceId: string, row: DeviceOwnerRow, ttlMs: number) =>
  replaceLeaseValue(OWNER_NAMESPACE, deviceId, row.token, { ...row }, ttlMs);

export const renewDeviceOwner = (deviceId: string, token: string, ttlMs: number) =>
  renewLease(OWNER_NAMESPACE, deviceId, token, ttlMs);

export const releaseDeviceOwner = (deviceId: string, token: string) =>
  releaseLease(OWNER_NAMESPACE, deviceId, token);

export const deviceOwner = (deviceId: string) =>
  getEphemeral<DeviceOwnerRow>(OWNER_NAMESPACE, deviceId);

export const recordRelayDevice = (taskId: string, deviceId: string) =>
  putEphemeral(RELAY_NAMESPACE, taskId, { deviceId }, RELAY_TTL_MS);

export const forgetRelayDevice = (taskId: string) => deleteEphemeral(RELAY_NAMESPACE, taskId);

export async function relayDevice(taskId: string): Promise<string | null> {
  return (await getEphemeral<{ deviceId: string }>(RELAY_NAMESPACE, taskId))?.deviceId ?? null;
}

// ── forwarding ────────────────────────────────────────────────────────────

function sendableCloseCode(code: number): number {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || code >= 3000
    ? code
    : 1011;
}

function asText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

/**
 * Pipe an accepted socket to the same path on the owner instance, preserving
 * the caller's own credentials (the owner re-authenticates them). Frames sent
 * before the upstream opens are queued; either side closing closes the other.
 */
export function proxySocket(
  downstream: WebSocket,
  target: string,
  pathAndQuery: string,
  headers: Record<string, string>
): void {
  const upstream = new WebSocket(`${target.replace(/^http/i, 'ws')}${pathAndQuery}`, {
    headers: { ...headers, [HUB_FORWARDED_HEADER]: '1' },
  });
  const queued: string[] = [];
  downstream.on('message', (raw) => {
    const text = asText(raw);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else queued.push(text);
  });
  upstream.on('open', () => {
    for (const text of queued.splice(0)) upstream.send(text);
  });
  upstream.on('message', (raw) => downstream.send(asText(raw)));
  upstream.on('close', (code, reason) => downstream.close(sendableCloseCode(code), reason));
  upstream.on('unexpected-response', (_request, response) => {
    downstream.close(response.statusCode === 401 ? 4401 : 1011, 'owner instance refused');
  });
  upstream.on('error', () => downstream.close(1011, 'owner instance unreachable'));
  // The owner pings its upstream leg, which this process answers; a half-open
  // downstream (a Mac that dropped off the network) is detected here.
  let alive = true;
  downstream.on('pong', () => {
    alive = true;
  });
  const keepAlive = setInterval(() => {
    if (!alive) {
      downstream.terminate();
      return;
    }
    alive = false;
    downstream.ping();
  }, PROXY_PING_INTERVAL_MS);
  keepAlive.unref();
  downstream.on('close', () => {
    clearInterval(keepAlive);
    if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, 'client closed');
    else upstream.terminate();
  });
  downstream.on('error', () => downstream.terminate());
}

export type InternalRequest =
  | { op: 'start'; deviceId: string; userId: string; command: unknown; deadlineMs?: number }
  | { op: 'stop'; taskId: string; deviceId: string | null }
  | { op: 'status'; taskId: string };

export type InternalResponse =
  { ok: true; folder?: string; tunnel?: boolean } | { ok: false; code: string; error: string };

/** One request/response to the owner instance's internal hub endpoint. */
export function callOwner(
  target: string,
  secret: string,
  request: InternalRequest
): Promise<InternalResponse> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${target.replace(/^http/i, 'ws')}${LOCAL_DEVICE_INTERNAL_PATH}`, {
      headers: { [INTERNAL_AUTH_HEADER]: internalAuth(secret), [HUB_FORWARDED_HEADER]: '1' },
    });
    let settled = false;
    const finish = (response: InternalResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(response);
    };
    const timer = setTimeout(
      () => finish({ ok: false, code: 'owner_timeout', error: 'owner instance did not answer' }),
      INTERNAL_CALL_TIMEOUT_MS
    );
    ws.on('open', () => ws.send(JSON.stringify(request)));
    ws.on('message', (raw) => {
      try {
        finish(JSON.parse(asText(raw)) as InternalResponse);
      } catch {
        finish({ ok: false, code: 'owner_protocol', error: 'malformed owner response' });
      }
    });
    const unreachable = () =>
      finish({
        ok: false,
        code: 'device_disconnected',
        error: 'The Rose Mac app is not connected',
      });
    ws.on('error', unreachable);
    ws.on('unexpected-response', unreachable);
    ws.on('close', unreachable);
  });
}
