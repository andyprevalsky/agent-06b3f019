/**
 * In-process hub for local code agents (C14): Mac app control channels and
 * per-task relays. See ./protocol.ts for the wire shapes and topology.
 *
 * Scale (10k-agent rule): one control socket per connected Mac app, one tunnel
 * socket per live local session, one channel per relay client. Routing is a
 * Map lookup by device id / task id / channel; nothing fans in per user.
 *
 * Connectivity is in-process: a device is "connected" when its control socket
 * is open on THIS backend instance. Render runs BACKEND_INSTANCES=1 (two only
 * during a rolling-deploy overlap, when a Mac reconnects to the new instance
 * within its reconnect backoff). Multi-instance routing needs a shared bus and
 * is a documented gap, not silently assumed.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { createLogger } from '../logger';
import { impersonatorFromPayload, verifySupabaseAccessToken } from '../supabaseJwt';
import {
  LOCAL_CODE_RELAY_PREFIX,
  LOCAL_DEVICE_CONTROL_PATH,
  LOCAL_DEVICE_ID_HEADER,
  type ControlFromDevice,
  type ControlToDevice,
  type TunnelToDevice,
  parseControlFromDevice,
  parseTunnelFromDevice,
  relayClientPath,
} from './protocol';
import {
  findActiveCodeSession,
  findLocalDevice,
  touchLocalDevice,
  type LocalDeviceRecord,
} from './store';

const log = createLogger('LocalDevices');

/** Control-plane liveness ping; a half-open Mac drops within two intervals. */
const PING_INTERVAL_MS = 25_000;
/** Bounded startup wait for the Mac to spawn ws-server and open its tunnel. */
export const LOCAL_SESSION_START_DEADLINE_MS = 30_000;

export interface LocalDeviceHubDeps {
  /** Verified, non-impersonated user id for a bearer token, or null. */
  verifyUser: (token: string) => Promise<string | null>;
  findDevice: (deviceId: string) => Promise<LocalDeviceRecord | null>;
  findActiveSession: (
    taskId: string
  ) => Promise<{ id: string; agentId: string; sandboxId: string } | null>;
  touchDevice: (deviceId: string) => Promise<void>;
  relaySecret: () => string;
  pingIntervalMs: number;
}

async function verifyNonImpersonatedUser(token: string): Promise<string | null> {
  try {
    const payload = await verifySupabaseAccessToken(token);
    // A local Mac session runs code on the account holder's own machine;
    // an operator impersonating them must never drive it.
    if (impersonatorFromPayload(payload) !== undefined) return null;
    return typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : null;
  } catch {
    return null;
  }
}

export function defaultRelaySecret(): string {
  const secret = process.env.LOCAL_CODE_RELAY_SECRET ?? process.env.BACKEND_API_KEY ?? '';
  if (secret === '') {
    throw new Error('LOCAL_CODE_RELAY_SECRET or BACKEND_API_KEY must be set for local code relays');
  }
  return secret;
}

const DEFAULT_DEPS: LocalDeviceHubDeps = {
  verifyUser: verifyNonImpersonatedUser,
  findDevice: findLocalDevice,
  findActiveSession: findActiveCodeSession,
  touchDevice: touchLocalDevice,
  relaySecret: defaultRelaySecret,
  pingIntervalMs: PING_INTERVAL_MS,
};

/** `mac-<deviceId>-<taskId>`: the Mac that owns a local session, recoverable after restarts. */
export const LOCAL_DEVICE_SANDBOX_PREFIX = 'mac-';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SANDBOX_ID_RE = new RegExp(`^mac-(${UUID})-(${UUID})$`, 'i');

export function localDeviceSandboxId(deviceId: string, taskId: string): string {
  return `${LOCAL_DEVICE_SANDBOX_PREFIX}${deviceId}-${taskId}`;
}

export function parseLocalDeviceSandboxId(
  sandboxId: string | null | undefined
): { deviceId: string; taskId: string } | null {
  if (typeof sandboxId !== 'string') return null;
  const match = SANDBOX_ID_RE.exec(sandboxId);
  return match === null ? null : { deviceId: match[1], taskId: match[2] };
}

export function isLocalDeviceSandboxId(sandboxId: string | null | undefined): boolean {
  return parseLocalDeviceSandboxId(sandboxId) !== null;
}

export class LocalSessionStartError extends Error {
  constructor(
    public readonly code:
      | 'device_disconnected'
      | 'no_folder_granted'
      | 'folder_not_granted'
      | 'spawn_failed'
      | 'start_deadline',
    message: string
  ) {
    super(message);
    this.name = 'LocalSessionStartError';
  }
}

interface DeviceConnection {
  deviceId: string;
  userId: string;
  socket: WebSocket;
  /** From the Mac's hello: where its per-session HOMEs live. */
  sessionsRoot: string | null;
}

interface PendingStart {
  resolve: (folder: string) => void;
  reject: (error: LocalSessionStartError) => void;
  timer: NodeJS.Timeout;
  folder: string | null;
}

interface RelaySession {
  taskId: string;
  deviceId: string;
  userId: string;
  tunnel: WebSocket | null;
  clients: Map<number, WebSocket>;
  nextChannel: number;
  pending: PendingStart | null;
}

function rawToString(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

export class LocalDeviceHub {
  private readonly devices = new Map<string, DeviceConnection>();
  private readonly sessions = new Map<string, RelaySession>();
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly deps: LocalDeviceHubDeps;

  constructor(deps: Partial<LocalDeviceHubDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  // ── public API used by session create/close and target checks ───────────

  isDeviceConnected(deviceId: string): boolean {
    const connection = this.devices.get(deviceId);
    return connection !== undefined && connection.socket.readyState === connection.socket.OPEN;
  }

  /** Session HOME for a task on this Mac (from its hello), or null when unknown. */
  deviceSessionHome(deviceId: string, taskId: string): string | null {
    const root = this.devices.get(deviceId)?.sessionsRoot ?? null;
    return root === null ? null : `${root.replace(/\/+$/, '')}/${taskId}`;
  }

  isSessionTunnelConnected(taskId: string): boolean {
    const session = this.sessions.get(taskId);
    return session?.tunnel !== null && session?.tunnel !== undefined;
  }

  relayToken(taskId: string): string {
    return createHmac('sha256', this.deps.relaySecret())
      .update(`local-code-relay:${taskId}`)
      .digest('hex');
  }

  /** ws(s):// URL a relay client (worker, FE chip) connects to. */
  relayClientUrl(taskId: string, baseUrl: string): string {
    const wsBase = baseUrl
      .replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`)
      .replace(/\/+$/, '');
    return `${wsBase}${relayClientPath(taskId)}?token=${this.relayToken(taskId)}`;
  }

  /**
   * Ask the Mac to start a session and wait until it reports `session_started`
   * AND its tunnel leg is connected. Rejects at once when the Mac is not
   * connected; never waits for one to appear.
   */
  async startSession(params: {
    deviceId: string;
    userId: string;
    command: Extract<ControlToDevice, { type: 'start_session' }>;
    deadlineMs?: number;
  }): Promise<{ folder: string }> {
    const connection = this.devices.get(params.deviceId);
    if (
      connection === undefined ||
      connection.userId !== params.userId ||
      !this.isDeviceConnected(params.deviceId)
    ) {
      throw new LocalSessionStartError('device_disconnected', 'The Rose Mac app is not connected');
    }
    const taskId = params.command.task_id;
    const session: RelaySession = {
      taskId,
      deviceId: params.deviceId,
      userId: params.userId,
      tunnel: null,
      clients: new Map(),
      nextChannel: 1,
      pending: null,
    };
    this.sessions.set(taskId, session);
    const started = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending = null;
        reject(
          new LocalSessionStartError(
            'start_deadline',
            `The Rose Mac app did not start the local session within ${Math.round((params.deadlineMs ?? LOCAL_SESSION_START_DEADLINE_MS) / 1000)}s`
          )
        );
      }, params.deadlineMs ?? LOCAL_SESSION_START_DEADLINE_MS);
      session.pending = { resolve, reject, timer, folder: null };
    });
    connection.socket.send(JSON.stringify(params.command));
    try {
      const folder = await started;
      return { folder };
    } catch (error) {
      this.dropSession(taskId, 'start failed');
      this.sendToDevice(params.deviceId, { type: 'stop_session', task_id: taskId });
      throw error;
    }
  }

  /** Stop a local session: tell the Mac (if connected) and drop its relay. */
  stopSession(taskId: string, deviceId: string | null): void {
    const session = this.sessions.get(taskId);
    const owner = session?.deviceId ?? deviceId;
    if (owner !== null) this.sendToDevice(owner, { type: 'stop_session', task_id: taskId });
    this.dropSession(taskId, 'session closed');
  }

  /**
   * Attach the control + relay endpoints to the backend HTTP server.
   * `otherUpgradePaths` are owned by other upgrade handlers; any remaining
   * unknown path is refused here so no upgrade socket is left dangling.
   */
  attach(server: Server, otherUpgradePaths: readonly string[] = []): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      if (pathname !== LOCAL_DEVICE_CONTROL_PATH && !pathname.startsWith(LOCAL_CODE_RELAY_PREFIX)) {
        if (!otherUpgradePaths.includes(pathname)) socket.destroy();
        return;
      }
      void this.routeUpgrade(request, socket, head, url).catch((error: unknown) => {
        log.warn('Local device upgrade failed', {
          path: pathname,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.destroy();
      });
    });
  }

  /** Close every socket (tests and graceful shutdown). */
  close(): void {
    for (const session of this.sessions.values()) this.dropSession(session.taskId, 'shutdown');
    for (const connection of this.devices.values()) connection.socket.close(1001, 'shutdown');
    this.devices.clear();
    this.wss.close();
  }

  // ── upgrade routing ─────────────────────────────────────────────────────

  private reject(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  private async authenticateDevice(
    request: IncomingMessage
  ): Promise<{ userId: string; device: LocalDeviceRecord } | null> {
    const token = bearer(request);
    const deviceId = headerValue(request, LOCAL_DEVICE_ID_HEADER);
    if (token === null || deviceId === null) return null;
    const userId = await this.deps.verifyUser(token);
    if (userId === null) return null;
    const device = await this.deps.findDevice(deviceId);
    if (device === null || device.userId !== userId) return null;
    return { userId, device };
  }

  private async routeUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL
  ): Promise<void> {
    if (url.pathname === LOCAL_DEVICE_CONTROL_PATH) {
      const auth = await this.authenticateDevice(request);
      if (auth === null) return this.reject(socket, 401, 'Unauthorized');
      this.wss.handleUpgrade(request, socket, head, (ws) => this.acceptControl(ws, auth));
      return;
    }
    const rest = url.pathname.slice(LOCAL_CODE_RELAY_PREFIX.length).split('/');
    const taskId = rest[0] ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) return this.reject(socket, 404, 'Not Found');
    if (rest.length === 2 && rest[1] === 'device') {
      const auth = await this.authenticateDevice(request);
      if (auth === null) return this.reject(socket, 401, 'Unauthorized');
      const session = await this.sessionForDevice(taskId, auth.device.id, auth.userId);
      if (session === null) return this.reject(socket, 403, 'Forbidden');
      this.wss.handleUpgrade(request, socket, head, (ws) => this.acceptTunnel(ws, session));
      return;
    }
    if (rest.length !== 1) return this.reject(socket, 404, 'Not Found');
    if (!this.tokenMatches(taskId, url.searchParams.get('token'))) {
      return this.reject(socket, 401, 'Unauthorized');
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.acceptClient(ws, taskId));
  }

  private tokenMatches(taskId: string, token: string | null): boolean {
    if (token === null) return false;
    const expected = Buffer.from(this.relayToken(taskId), 'utf8');
    const actual = Buffer.from(token, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /**
   * The relay a device may serve: an in-memory session it owns, or — after a
   * backend restart — an ACTIVE DB session whose sandbox id names this device.
   */
  private async sessionForDevice(
    taskId: string,
    deviceId: string,
    userId: string
  ): Promise<RelaySession | null> {
    const live = this.sessions.get(taskId);
    if (live !== undefined) {
      return live.deviceId === deviceId && live.userId === userId ? live : null;
    }
    const row = await this.deps.findActiveSession(taskId);
    const owner = parseLocalDeviceSandboxId(row?.sandboxId);
    if (row === null || owner === null || owner.deviceId !== deviceId || owner.taskId !== taskId) {
      return null;
    }
    const restored: RelaySession = {
      taskId,
      deviceId,
      userId,
      tunnel: null,
      clients: new Map(),
      nextChannel: 1,
      pending: null,
    };
    this.sessions.set(taskId, restored);
    return restored;
  }

  // ── control channel ─────────────────────────────────────────────────────

  private acceptControl(ws: WebSocket, auth: { userId: string; device: LocalDeviceRecord }): void {
    const deviceId = auth.device.id;
    const previous = this.devices.get(deviceId);
    if (previous !== undefined) previous.socket.close(4001, 'replaced by a newer connection');
    this.devices.set(deviceId, { deviceId, userId: auth.userId, socket: ws, sessionsRoot: null });
    void this.deps.touchDevice(deviceId).catch(() => undefined);
    log.info('Mac app control channel connected', { device_id: deviceId });
    const stopPing = this.keepAlive(ws);
    ws.on('message', (raw) => this.onControlMessage(deviceId, rawToString(raw)));
    ws.on('close', () => {
      stopPing();
      if (this.devices.get(deviceId)?.socket === ws) {
        this.devices.delete(deviceId);
        void this.deps.touchDevice(deviceId).catch(() => undefined);
        log.info('Mac app control channel closed', { device_id: deviceId });
        for (const session of this.sessions.values()) {
          if (session.deviceId === deviceId && session.pending !== null) {
            clearTimeout(session.pending.timer);
            session.pending.reject(
              new LocalSessionStartError('device_disconnected', 'The Rose Mac app disconnected')
            );
            session.pending = null;
          }
        }
      }
    });
    ws.on('error', () => ws.terminate());
  }

  private onControlMessage(deviceId: string, raw: string): void {
    const message: ControlFromDevice | null = parseControlFromDevice(raw);
    if (message === null) return;
    if (message.type === 'hello') {
      const connection = this.devices.get(deviceId);
      if (connection !== undefined) connection.sessionsRoot = message.sessions_root ?? null;
      log.info('Mac app hello', { device_id: deviceId, live_sessions: message.sessions.length });
      return;
    }
    const session = this.sessions.get(message.task_id);
    if (session === undefined || session.deviceId !== deviceId) return;
    if (message.type === 'session_started') {
      if (session.pending !== null) session.pending.folder = message.folder;
      this.settleStartIfReady(session);
      return;
    }
    if (message.type === 'session_failed') {
      if (session.pending !== null) {
        clearTimeout(session.pending.timer);
        session.pending.reject(new LocalSessionStartError(message.code, message.error));
        session.pending = null;
      }
      return;
    }
    // session_exited: the ws-server lingers for reattach; clients see its exit frame.
    log.info('Local session exited on the Mac', {
      device_id: deviceId,
      task_id: message.task_id,
      code: message.code,
    });
  }

  private settleStartIfReady(session: RelaySession): void {
    const pending = session.pending;
    if (pending === null || pending.folder === null || session.tunnel === null) return;
    clearTimeout(pending.timer);
    session.pending = null;
    pending.resolve(pending.folder);
  }

  private sendToDevice(deviceId: string, message: ControlToDevice): void {
    const connection = this.devices.get(deviceId);
    if (connection !== undefined && this.isDeviceConnected(deviceId)) {
      connection.socket.send(JSON.stringify(message));
    }
  }

  // ── tunnel + relay clients ──────────────────────────────────────────────

  private acceptTunnel(ws: WebSocket, session: RelaySession): void {
    if (session.tunnel !== null) session.tunnel.close(4001, 'replaced by a newer tunnel');
    session.tunnel = ws;
    const stopPing = this.keepAlive(ws);
    // Clients that connected while the tunnel was down were refused; re-open
    // channels for any that are still attached (none after a refusal).
    for (const ch of session.clients.keys()) this.sendTunnel(session, { op: 'open', ch });
    this.settleStartIfReady(session);
    ws.on('message', (raw) => {
      const frame = parseTunnelFromDevice(rawToString(raw));
      if (frame === null) return;
      const client = session.clients.get(frame.ch);
      if (client === undefined) return;
      if (frame.op === 'data') client.send(frame.data);
      else {
        session.clients.delete(frame.ch);
        client.close(1000, 'session channel closed');
      }
    });
    ws.on('close', () => {
      stopPing();
      if (session.tunnel !== ws) return;
      session.tunnel = null;
      // The worker's client reconnects (bounded) when the Mac's tunnel returns.
      for (const client of session.clients.values()) client.close(1012, 'Mac tunnel closed');
      session.clients.clear();
    });
    ws.on('error', () => ws.terminate());
  }

  private acceptClient(ws: WebSocket, taskId: string): void {
    const session = this.sessions.get(taskId);
    if (session === undefined || session.tunnel === null) {
      ws.close(1013, 'The Rose Mac app is not connected');
      return;
    }
    const ch = session.nextChannel;
    session.nextChannel += 1;
    session.clients.set(ch, ws);
    this.sendTunnel(session, { op: 'open', ch });
    ws.on('message', (raw) => this.sendTunnel(session, { op: 'data', ch, data: rawToString(raw) }));
    ws.on('close', () => {
      if (session.clients.get(ch) === ws) {
        session.clients.delete(ch);
        this.sendTunnel(session, { op: 'close', ch });
      }
    });
    ws.on('error', () => ws.terminate());
  }

  private sendTunnel(session: RelaySession, frame: TunnelToDevice): void {
    if (session.tunnel !== null && session.tunnel.readyState === session.tunnel.OPEN) {
      session.tunnel.send(JSON.stringify(frame));
    }
  }

  private dropSession(taskId: string, reason: string): void {
    const session = this.sessions.get(taskId);
    if (session === undefined) return;
    this.sessions.delete(taskId);
    if (session.pending !== null) clearTimeout(session.pending.timer);
    for (const client of session.clients.values()) client.close(1000, reason);
    session.tunnel?.close(1000, reason);
  }

  private keepAlive(ws: WebSocket): () => void {
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const timer = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, this.deps.pingIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

let defaultHub: LocalDeviceHub | null = null;

/** The process-wide hub (one per backend instance). */
export function localDeviceHub(): LocalDeviceHub {
  defaultHub ??= new LocalDeviceHub();
  return defaultHub;
}
