/**
 * local-code-runner — repo layer (I/O only: store, filesystem, processes,
 * sockets, backend HTTP). No business logic.
 */
import { execFile, execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { createServer } from 'net';
import os from 'os';
import path from 'path';
import Store from 'electron-store';
import WebSocket from 'ws';
import { config } from '../../base/config';
import { sessionForLocalMachineData } from '../../base/impersonation';
import { AuthService } from '../../services/auth';
import {
  DEV_TEMPLATES_DIR,
  DEVICE_ID_HEADER,
  PACKAGED_CODE_AGENT_DIR,
  REGISTER_PATH,
  SESSIONS_DIR,
  STORE_NAME,
  TERMINAL_LOG_FILE,
  WS_SERVER_RELATIVE,
} from './config';
import type {
  ChildLike,
  ExecSpec,
  FolderGrant,
  HomeFile,
  LocalCodeProvider,
  LocalDeviceIdentity,
  SocketLike,
  SpawnSpec,
} from './types';

interface RunnerStoreSchema {
  deviceId: string;
  grants: FolderGrant[];
}

const store = new Store<RunnerStoreSchema>({
  name: STORE_NAME,
  encryptionKey: config.encryptionKey,
  clearInvalidConfig: true,
});

export function loadDeviceId(): string {
  const existing = store.get('deviceId', '');
  if (typeof existing === 'string' && existing !== '') return existing;
  const minted = randomUUID();
  store.set('deviceId', minted);
  return minted;
}

export function loadGrants(): FolderGrant[] {
  const grants = store.get('grants', []);
  return Array.isArray(grants) ? grants : [];
}

export function saveGrants(grants: FolderGrant[]): void {
  store.set('grants', grants);
}

/** The Mac's user-facing name ("Andy's MacBook Pro"), not its DNS hostname. */
export function readComputerName(): string {
  try {
    const name = execFileSync('scutil', ['--get', 'ComputerName'], {
      encoding: 'utf8',
      timeout: 2_000,
    }).trim();
    if (name !== '') return name;
  } catch {
    // not macOS or scutil unavailable
  }
  return os.hostname().replace(/\.local$/, '');
}

export const folderFs = {
  realpath: (p: string): string => fs.realpathSync.native(p),
  isDirectory: (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

export async function getMachineAccessToken(): Promise<string | null> {
  const session = sessionForLocalMachineData(await AuthService.getSession());
  const token = session?.access_token;
  return typeof token === 'string' && token !== '' ? token : null;
}

export async function registerDevice(
  accessToken: string,
  identity: LocalDeviceIdentity,
  appVersion: string
): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(`${config.apiUrl}${REGISTER_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: identity.deviceId,
      name: identity.name,
      platform: process.platform,
      app_version: appVersion,
    }),
  });
  return { ok: response.ok, status: response.status };
}

export function openAuthenticatedSocket(
  url: string,
  accessToken: string,
  deviceId: string
): WebSocket {
  return new WebSocket(url, {
    headers: { Authorization: `Bearer ${accessToken}`, [DEVICE_ID_HEADER]: deviceId },
  });
}

export function connectLocalSocket(port: number): SocketLike {
  return new WebSocket(`ws://127.0.0.1:${port}`) as unknown as SocketLike;
}

export async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free local port'))));
    });
    server.on('error', reject);
  });
}

export function wsServerPath(provider: LocalCodeProvider, isPackaged: boolean): string {
  return isPackaged
    ? path.join(process.resourcesPath, PACKAGED_CODE_AGENT_DIR, WS_SERVER_RELATIVE[provider])
    : // dist/main/main/domains/local-code-runner → repository root
      path.resolve(__dirname, '../../../../../..', DEV_TEMPLATES_DIR, WS_SERVER_RELATIVE[provider]);
}

export async function makeSessionHome(userDataDir: string, taskId: string): Promise<string> {
  const dir = path.join(sessionsRoot(userDataDir), taskId);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function sessionsRoot(userDataDir: string): string {
  return path.join(userDataDir, SESSIONS_DIR);
}

/** Write backend-provided HOME files (paths already validated relative). */
export async function writeHomeFiles(sessionHome: string, files: HomeFile[]): Promise<void> {
  const root = path.resolve(sessionHome);
  for (const file of files) {
    const target = path.resolve(root, file.path);
    if (!target.startsWith(`${root}${path.sep}`))
      throw new Error(`refusing to write outside HOME: ${file.path}`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(target, Buffer.from(file.content_base64, 'base64'), {
      mode: file.executable ? 0o755 : 0o600,
    });
  }
}

export function terminalLogPath(sessionHome: string): string {
  return path.join(sessionHome, TERMINAL_LOG_FILE);
}

export function appendTerminal(logPath: string, text: string): void {
  fs.appendFile(logPath, text, { mode: 0o600 }, () => undefined);
}

interface SpawnedChild extends ChildLike {
  stdoutLines: (listener: (line: string) => void) => void;
}

export function spawnProcess(spec: SpawnSpec): SpawnedChild {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  const lineListeners: Array<(line: string) => void> = [];
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) for (const listener of lineListeners) listener(line);
  });
  child.stderr?.on('data', () => undefined);
  return {
    kill: (signal) => {
      child.kill(signal ?? 'SIGTERM');
    },
    onExit: (listener) => {
      child.once('exit', (code) => listener(code));
    },
    stdoutLines: (listener) => lineListeners.push(listener),
  };
}

/** Wait for ws-server's authenticated JSON readiness record (same as the backend's local fallback). */
export function waitForReady(
  child: ChildLike,
  port: number,
  token: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.onExit(() => finish(false));
    (child as SpawnedChild).stdoutLines((line) => {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (
          record.message === 'Server listening' &&
          record.port === port &&
          record.readinessToken === token
        ) {
          finish(true);
        }
      } catch {
        // only the JSON readiness record counts
      }
    });
  });
}

export function runExec(spec: ExecSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(spec.file, spec.args, { timeout: 10_000 }, (error) =>
      error ? reject(error) : resolve()
    );
  });
}
