/**
 * local-code-runner — runtime layer (Electron wiring)
 *
 *   app ready ─► device id (persisted) + Computer Name
 *            ─► stamp X-Rose-Device-Id on renderer → backend requests (agent origin)
 *            ─► control loop: register device (machine JWT) → control WS
 *                 ◀── start_session / stop_session ─► LocalSessionManager
 *                 ──► hello{live sessions} on every (re)connect, then re-open tunnels
 *                 close → reconnect with backoff (1s … 30s); the backend sees the
 *                 Mac as disconnected immediately, so a local code agent fails at once
 *   IPC: localCode:getStatus | addGrant | removeGrant | setDefaultGrant | openTerminal
 *   event: localCode:status (pushed to every window on any change)
 */
import { randomUUID } from 'crypto';
import os from 'os';
import { BrowserWindow, app, dialog, ipcMain, session } from 'electron';
import type WebSocket from 'ws';
import { config } from '../../base/config';
import { getAugmentedEnv } from '../../base/shellEnv';
import { logConsole, logConsoleError, logIpc } from '../../base/logger';
import { getErrorMessage } from '../../../shared/utils/error';
import { CONTROL_PATH, DEVICE_ID_HEADER, LOG_TAG } from './config';
import * as repo from './repo';
import {
  addGrant,
  backendWsUrl,
  parseControlMessage,
  reconnectDelayMs,
  removeGrant,
  setDefaultGrant,
} from './service';
import { LocalSessionManager } from './serviceSession';
import type { ControlFromDevice, LocalCodeStatus, LocalDeviceIdentity, SocketLike } from './types';

let identity: LocalDeviceIdentity | null = null;
let manager: LocalSessionManager | null = null;
let control: WebSocket | null = null;
let connected = false;
let stopping = false;

function sendControl(message: ControlFromDevice): void {
  if (control !== null && control.readyState === control.OPEN)
    control.send(JSON.stringify(message));
}

export function getStatus(): LocalCodeStatus {
  return {
    deviceId: identity?.deviceId ?? '',
    deviceName: identity?.name ?? '',
    connected,
    grants: repo.loadGrants(),
    sessions: manager?.views() ?? [],
  };
}

function broadcastStatus(): void {
  const status = getStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('localCode:status', status);
  }
}

function buildManager(deviceId: string): LocalSessionManager {
  return new LocalSessionManager({
    grants: repo.loadGrants,
    fs: repo.folderFs,
    home: os.homedir(),
    execPath: process.execPath,
    hostEnv: process.env,
    shellPath: () => getAugmentedEnv().PATH ?? '',
    wsServerPath: (provider) => repo.wsServerPath(provider, app.isPackaged),
    allocatePort: repo.allocatePort,
    newToken: randomUUID,
    makeSessionHome: (taskId) => repo.makeSessionHome(app.getPath('userData'), taskId),
    terminalLogPath: repo.terminalLogPath,
    spawn: repo.spawnProcess,
    waitForReady: repo.waitForReady,
    openTunnel: async (relayPath) => {
      const token = await repo.getMachineAccessToken();
      if (token === null) throw new Error('Not signed in to Rose on this Mac');
      const socket = repo.openAuthenticatedSocket(
        backendWsUrl(config.apiUrl, relayPath),
        token,
        deviceId
      );
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
        socket.once('unexpected-response', (_req, res) =>
          reject(new Error(`HTTP ${res.statusCode ?? 0}`))
        );
      });
      return socket as unknown as SocketLike;
    },
    connectLocal: repo.connectLocalSocket,
    appendTerminal: repo.appendTerminal,
    openTerminal: repo.runExec,
    sendControl: (message) => {
      sendControl(message);
      broadcastStatus();
    },
    now: () => new Date().toISOString(),
  });
}

async function connectOnce(device: LocalDeviceIdentity): Promise<WebSocket | null> {
  const token = await repo.getMachineAccessToken();
  if (token === null) return null; // signed out or impersonating: never offer this Mac
  const registered = await repo.registerDevice(token, device, app.getVersion());
  if (!registered.ok) {
    logConsoleError(LOG_TAG, `Device registration failed (HTTP ${registered.status})`);
    return null;
  }
  const socket = repo.openAuthenticatedSocket(
    backendWsUrl(config.apiUrl, CONTROL_PATH),
    token,
    device.deviceId
  );
  return await new Promise((resolve) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', () => resolve(null));
    socket.once('unexpected-response', () => resolve(null));
  });
}

function onControlOpen(socket: WebSocket, done: () => void): void {
  control = socket;
  connected = true;
  logConsole(LOG_TAG, 'Control channel connected');
  sendControl({ type: 'hello', sessions: manager?.liveTaskIds() ?? [] });
  void manager?.reattachTunnels();
  broadcastStatus();
  socket.on('message', (raw) => {
    const message = parseControlMessage(raw.toString());
    if (message === null || manager === null) return;
    if (message.type === 'start_session') {
      manager.start(message).then(broadcastStatus, (error: unknown) => {
        sendControl({
          type: 'session_failed',
          task_id: message.task_id,
          code: 'spawn_failed',
          error: getErrorMessage(error),
        });
      });
    } else {
      manager.stop(message.task_id);
      broadcastStatus();
    }
  });
  socket.on('close', () => {
    if (control === socket) control = null;
    connected = false;
    broadcastStatus();
    done();
  });
}

async function controlLoop(device: LocalDeviceIdentity): Promise<void> {
  let attempt = 0;
  while (!stopping) {
    let socket: WebSocket | null = null;
    try {
      socket = await connectOnce(device);
    } catch (error) {
      logConsoleError(LOG_TAG, 'Control channel connect failed', error);
    }
    if (socket !== null) {
      attempt = 0;
      await new Promise<void>((resolve) => onControlOpen(socket, resolve));
    }
    if (stopping) return;
    await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs(attempt)));
    attempt += 1;
  }
}

/** Every renderer request to the backend names this Mac (recorded as agent origin). */
function stampDeviceHeader(deviceId: string): void {
  const origin = new URL(config.apiUrl).origin;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, [DEVICE_ID_HEADER]: deviceId } });
    }
  );
}

function updateGrants(next: ReturnType<typeof repo.loadGrants>): LocalCodeStatus {
  repo.saveGrants(next);
  broadcastStatus();
  return getStatus();
}

export function registerLocalCodeHandlers(): void {
  ipcMain.handle('localCode:getStatus', () => getStatus());
  ipcMain.handle('localCode:addGrant', async (_event, requested?: string) => {
    logIpc('IN', 'localCode:addGrant');
    let folder = requested;
    if (folder === undefined) {
      const picked = await dialog.showOpenDialog({
        title: 'Share a folder with Rose',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (picked.canceled || picked.filePaths.length === 0)
        return { success: false, status: getStatus() };
      folder = picked.filePaths[0];
    }
    try {
      const next = addGrant(repo.loadGrants(), folder, repo.folderFs, {
        id: randomUUID(),
        now: new Date().toISOString(),
        home: os.homedir(),
      });
      return { success: true, status: updateGrants(next) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error), status: getStatus() };
    }
  });
  ipcMain.handle('localCode:removeGrant', (_event, id: string) => ({
    success: true,
    status: updateGrants(removeGrant(repo.loadGrants(), id)),
  }));
  ipcMain.handle('localCode:setDefaultGrant', (_event, id: string) => ({
    success: true,
    status: updateGrants(setDefaultGrant(repo.loadGrants(), id)),
  }));
  ipcMain.handle('localCode:openTerminal', async (_event, taskId: string) => ({
    success: (await manager?.openTerminalFor(taskId)) === true,
  }));
}

export function startLocalCodeRunner(): void {
  if (identity !== null) return;
  identity = { deviceId: repo.loadDeviceId(), name: repo.readComputerName() };
  manager = buildManager(identity.deviceId);
  stampDeviceHeader(identity.deviceId);
  registerLocalCodeHandlers();
  app.on('before-quit', () => {
    stopping = true;
    manager?.stopAll();
    control?.close(1001, 'Rose Mac app quitting');
  });
  void controlLoop(identity);
}
