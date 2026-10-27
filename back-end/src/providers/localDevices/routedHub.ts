/**
 * The production local-device hub: LocalDeviceHub plus cross-instance routing
 * (./instanceRouting.ts). The instance holding a Mac's control channel owns
 * the device; tunnels, relay clients and start/stop/status calls that land on
 * another instance are forwarded to it.
 *
 *   state               where                         lifetime
 *   ─────────────────── ───────────────────────────── ──────────────────────────
 *   device owner        local-device-owner/<device>   renewed every control ping
 *   task → device       local-relay-device/<task>     set at start, cleared at stop
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { WebSocket } from 'ws';
import { createLogger } from '../logger';
import {
  LOCAL_SESSION_START_DEADLINE_MS,
  LocalDeviceHub,
  LocalSessionStartError,
  parseLocalDeviceSandboxId,
  type LocalDeviceHubDeps,
} from './hub';
import {
  INTERNAL_CALL_TIMEOUT_MS,
  LOCAL_DEVICE_INTERNAL_PATH,
  callOwner,
  claimDeviceOwner,
  deviceOwner,
  forgetRelayDevice,
  internalAuthMatches,
  proxySocket,
  recordRelayDevice,
  relayDevice,
  releaseDeviceOwner,
  renewDeviceOwner,
  thisInstanceUrl,
  updateDeviceOwner,
  wasForwarded,
  type DeviceOwnerRow,
  type InternalRequest,
  type InternalResponse,
} from './instanceRouting';
import { LOCAL_DEVICE_ID_HEADER, type ControlToDevice } from './protocol';

const log = createLogger('LocalDevicesRouting');

type StartParams = Parameters<LocalDeviceHub['startSession']>[0];
type StartCode = LocalSessionStartError['code'];
const START_CODES: readonly StartCode[] = [
  'device_disconnected',
  'no_folder_granted',
  'folder_not_granted',
  'spawn_failed',
  'start_deadline',
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RoutedLocalDeviceHub extends LocalDeviceHub {
  private readonly owned = new Map<string, { row: DeviceOwnerRow; timer: NodeJS.Timeout }>();
  private readonly instance: string;

  constructor(deps: Partial<LocalDeviceHubDeps> = {}, instance: string = thisInstanceUrl()) {
    super(deps);
    this.instance = instance;
  }

  private get ownerTtlMs(): number {
    return Math.max(this.deps.pingIntervalMs * 3, 5_000);
  }

  /** The live owner row when ANOTHER instance owns the device, else null. */
  private async remoteOwner(deviceId: string): Promise<DeviceOwnerRow | null> {
    if (this.devices.has(deviceId)) return null;
    const row = await deviceOwner(deviceId);
    return row !== undefined && row.instance !== this.instance ? row : null;
  }

  // ── public API ──────────────────────────────────────────────────────────

  override async deviceOnline(deviceId: string): Promise<boolean> {
    if (this.isDeviceConnected(deviceId)) return true;
    return (await this.remoteOwner(deviceId)) !== null;
  }

  override async sessionHome(deviceId: string, taskId: string): Promise<string | null> {
    const local = this.deviceSessionHome(deviceId, taskId);
    if (local !== null) return local;
    const root = (await this.remoteOwner(deviceId))?.sessionsRoot ?? null;
    return root === null ? null : `${root.replace(/\/+$/, '')}/${taskId}`;
  }

  override async sessionLive(deviceId: string, taskId: string): Promise<boolean> {
    const owner = await this.remoteOwner(deviceId);
    if (owner === null) return super.sessionLive(deviceId, taskId);
    const response = await callOwner(owner.instance, this.deps.relaySecret(), {
      op: 'status',
      taskId,
    });
    return response.ok && response.tunnel === true;
  }

  override async startSession(params: StartParams): Promise<{ folder: string }> {
    const owner = await this.remoteOwner(params.deviceId);
    if (owner === null) return this.startSessionHere(params);
    if (owner.userId !== params.userId) {
      throw new LocalSessionStartError('device_disconnected', 'The Rose Mac app is not connected');
    }
    const response = await callOwner(owner.instance, this.deps.relaySecret(), {
      op: 'start',
      deviceId: params.deviceId,
      userId: params.userId,
      command: params.command,
      // The owner must answer before this call's own timeout, or a late start
      // would leave a session running that the caller already gave up on.
      deadlineMs: Math.min(
        params.deadlineMs ?? LOCAL_SESSION_START_DEADLINE_MS,
        INTERNAL_CALL_TIMEOUT_MS - 10_000
      ),
    });
    if (response.ok && typeof response.folder === 'string') return { folder: response.folder };
    if (response.ok) throw new LocalSessionStartError('spawn_failed', 'owner returned no folder');
    const code = START_CODES.includes(response.code as StartCode)
      ? (response.code as StartCode)
      : 'device_disconnected';
    throw new LocalSessionStartError(code, response.error);
  }

  override async stopSession(taskId: string, deviceId: string | null): Promise<void> {
    const sessionDevice = this.sessions.get(taskId)?.deviceId ?? deviceId;
    const owner = sessionDevice === null ? null : await this.remoteOwner(sessionDevice);
    if (owner === null || this.sessions.has(taskId)) {
      this.stopSessionHere(taskId, deviceId);
    } else {
      await callOwner(owner.instance, this.deps.relaySecret(), { op: 'stop', taskId, deviceId });
    }
    await forgetRelayDevice(taskId).catch((error: unknown) =>
      log.warn('Relay device row delete failed; it expires', {
        task_id: taskId,
        error: errorText(error),
      })
    );
  }

  private async startSessionHere(params: StartParams): Promise<{ folder: string }> {
    // Relay clients for this task may land on any instance; they find the
    // device (and from it this owner) through this row.
    await recordRelayDevice(params.command.task_id, params.deviceId);
    return super.startSession(params);
  }

  // ── owner registry, driven by the control channel ───────────────────────

  protected override onControlOpened(deviceId: string, userId: string, _ws: WebSocket): void {
    this.claimOwner(deviceId, userId);
  }

  /**
   * Claim (or re-claim) the owner row for a device whose control channel is
   * open here, and keep it renewed. A renewal that finds the row gone (expired
   * through a database outage, or replaced) re-claims it while the socket is
   * still here, so the device never stays invisible to other instances.
   */
  private claimOwner(deviceId: string, userId: string): void {
    const ttl = this.ownerTtlMs;
    const sessionsRoot = this.devices.get(deviceId)?.sessionsRoot ?? null;
    void claimDeviceOwner(deviceId, { instance: this.instance, userId, sessionsRoot }, ttl)
      .then((token) => {
        const previous = this.owned.get(deviceId);
        if (previous !== undefined) clearInterval(previous.timer);
        if (!this.devices.has(deviceId)) {
          this.owned.delete(deviceId);
          void releaseDeviceOwner(deviceId, token);
          return;
        }
        const row: DeviceOwnerRow = { token, instance: this.instance, userId, sessionsRoot };
        const timer = setInterval(
          () => this.renewOwner(deviceId, userId, token),
          this.deps.pingIntervalMs
        );
        timer.unref();
        this.owned.set(deviceId, { row, timer });
        const root = this.devices.get(deviceId)?.sessionsRoot ?? null;
        if (root !== sessionsRoot) this.onControlHello(deviceId, root);
      })
      .catch((error: unknown) =>
        log.warn('Device owner claim failed', { device_id: deviceId, error: errorText(error) })
      );
  }

  private renewOwner(deviceId: string, userId: string, token: string): void {
    void renewDeviceOwner(deviceId, token, this.ownerTtlMs)
      .then((renewed) => {
        if (renewed || this.owned.get(deviceId)?.row.token !== token) return;
        if (!this.devices.has(deviceId)) return;
        log.warn('Device owner row lost while connected; re-claiming', { device_id: deviceId });
        this.claimOwner(deviceId, userId);
      })
      .catch((error: unknown) =>
        log.warn('Device owner renew failed', { device_id: deviceId, error: errorText(error) })
      );
  }

  protected override onControlHello(deviceId: string, sessionsRoot: string | null): void {
    const owned = this.owned.get(deviceId);
    if (owned === undefined) return;
    owned.row = { ...owned.row, sessionsRoot };
    void updateDeviceOwner(deviceId, owned.row, this.ownerTtlMs).catch((error: unknown) =>
      log.warn('Device owner update failed', { device_id: deviceId, error: errorText(error) })
    );
  }

  protected override onControlClosed(deviceId: string): void {
    const owned = this.owned.get(deviceId);
    if (owned === undefined) return;
    this.owned.delete(deviceId);
    clearInterval(owned.timer);
    void releaseDeviceOwner(deviceId, owned.row.token).catch(() => undefined);
  }

  override close(): void {
    for (const [deviceId, owned] of this.owned) {
      clearInterval(owned.timer);
      void releaseDeviceOwner(deviceId, owned.row.token).catch(() => undefined);
    }
    this.owned.clear();
    super.close();
  }

  // ── upgrade forwarding ──────────────────────────────────────────────────

  protected override ownsUpgradePath(pathname: string): boolean {
    return pathname === LOCAL_DEVICE_INTERNAL_PATH;
  }

  protected override async forwardUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: { deviceId: string } | { taskId: string }
  ): Promise<boolean> {
    if (wasForwarded(request)) return false;
    let deviceId: string | null;
    if ('deviceId' in target) {
      deviceId = target.deviceId;
    } else {
      if (this.sessions.has(target.taskId)) return false;
      deviceId =
        (await relayDevice(target.taskId)) ??
        parseLocalDeviceSandboxId((await this.deps.findActiveSession(target.taskId))?.sandboxId)
          ?.deviceId ??
        null;
    }
    const owner = deviceId === null ? null : await this.remoteOwner(deviceId);
    if (owner === null) return false;
    const headers: Record<string, string> = {};
    if (typeof request.headers.authorization === 'string') {
      headers.authorization = request.headers.authorization;
    }
    const device = request.headers[LOCAL_DEVICE_ID_HEADER];
    if (typeof device === 'string') headers[LOCAL_DEVICE_ID_HEADER] = device;
    this.wss.handleUpgrade(request, socket, head, (ws) =>
      proxySocket(ws, owner.instance, request.url ?? '/', headers)
    );
    return true;
  }

  protected override async routeExtraUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    if (!internalAuthMatches(request, this.deps.relaySecret())) {
      this.reject(socket, 401, 'Unauthorized');
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => ws.terminate());
      ws.once('message', (raw) => {
        void this.answerInternal(raw.toString())
          .then((response) => ws.send(JSON.stringify(response)))
          .catch((error: unknown) =>
            ws.send(JSON.stringify({ ok: false, code: 'owner_error', error: errorText(error) }))
          );
      });
    });
  }

  /** Requests forwarded by peer instances; served only from local state. */
  private async answerInternal(raw: string): Promise<InternalResponse> {
    const request = JSON.parse(raw) as InternalRequest;
    if (request.op === 'status') {
      return { ok: true, tunnel: this.isSessionTunnelConnected(request.taskId) };
    }
    if (request.op === 'stop') {
      this.stopSessionHere(request.taskId, request.deviceId);
      return { ok: true };
    }
    if (!this.devices.has(request.deviceId)) {
      return { ok: false, code: 'device_disconnected', error: 'The Rose Mac app is not connected' };
    }
    try {
      const { folder } = await this.startSessionHere({
        deviceId: request.deviceId,
        userId: request.userId,
        command: request.command as Extract<ControlToDevice, { type: 'start_session' }>,
        deadlineMs: request.deadlineMs,
      });
      return { ok: true, folder };
    } catch (error) {
      return error instanceof LocalSessionStartError
        ? { ok: false, code: error.code, error: error.message }
        : { ok: false, code: 'spawn_failed', error: errorText(error) };
    }
  }
}
