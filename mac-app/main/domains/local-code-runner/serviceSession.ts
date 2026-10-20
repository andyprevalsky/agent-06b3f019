/**
 * local-code-runner — session manager (service layer; all I/O injected)
 *
 *   start_session ─► resolveSessionFolder ─✗─► session_failed(no_folder_granted | folder_not_granted)
 *                         │
 *                         ▼
 *                   spawn ws-server.mjs (cwd = grant) ─✗─► session_failed(spawn_failed)
 *                         │ ready
 *                         ▼
 *                   open tunnel (owner JWT) ─► TunnelMux ─► session_started{folder label}
 *                         │
 *                         ├─► terminal feed (local WS) ─► terminal.log ─► Terminal.app `tail -F`
 *                         └─► exit ─► session_exited
 *   stop_session ─► SIGTERM ws-server, close tunnel
 */
import { logConsole, logConsoleError } from '../../base/logger';
import { getErrorMessage } from '../../../shared/utils/error';
import { LOG_TAG, WS_SERVER_READY_TIMEOUT_MS } from './config';
import {
  LocalFolderError,
  buildTerminalAttachCommand,
  buildWsServerSpawn,
  displayFolder,
  resolveSessionFolder,
  terminalTextFromFrame,
  type FolderFs,
} from './service';
import { TunnelMux } from './serviceTunnel';
import type {
  ChildLike,
  ControlFromDevice,
  ExecSpec,
  FolderGrant,
  LocalCodeProvider,
  LocalSessionView,
  SocketLike,
  SpawnSpec,
  StartSessionCommand,
} from './types';

export interface SessionDeps {
  grants: () => FolderGrant[];
  fs: FolderFs;
  home: string;
  execPath: string;
  hostEnv: Record<string, string | undefined>;
  shellPath: () => string;
  wsServerPath: (provider: LocalCodeProvider) => string;
  allocatePort: () => Promise<number>;
  newToken: () => string;
  makeSessionHome: (taskId: string) => Promise<string>;
  terminalLogPath: (sessionHome: string) => string;
  spawn: (spec: SpawnSpec) => ChildLike;
  waitForReady: (
    child: ChildLike,
    port: number,
    token: string,
    timeoutMs: number
  ) => Promise<boolean>;
  openTunnel: (relayPath: string) => Promise<SocketLike>;
  connectLocal: (port: number) => SocketLike;
  appendTerminal: (logPath: string, text: string) => void;
  openTerminal: (spec: ExecSpec) => Promise<void>;
  sendControl: (message: ControlFromDevice) => void;
  now: () => string;
}

interface LiveSession {
  view: LocalSessionView;
  relayPath: string;
  port: number;
  child: ChildLike;
  mux: TunnelMux | null;
  feed: SocketLike;
  logPath: string;
  stopped: boolean;
}

export class LocalSessionManager {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(private readonly deps: SessionDeps) {}

  liveTaskIds(): string[] {
    return [...this.sessions.keys()];
  }

  views(): LocalSessionView[] {
    return [...this.sessions.values()].map((session) => session.view);
  }

  async start(command: StartSessionCommand): Promise<void> {
    const existing = this.sessions.get(command.task_id);
    if (existing !== undefined) {
      // A redelivered start for a running session only re-acknowledges it.
      this.deps.sendControl({
        type: 'session_started',
        task_id: command.task_id,
        folder: existing.view.folder,
      });
      return;
    }
    let folder: string;
    try {
      ({ folder } = resolveSessionFolder(command.folder, this.deps.grants(), this.deps.fs));
    } catch (error) {
      const code =
        error instanceof LocalFolderError && error.code !== 'invalid_folder'
          ? error.code
          : 'folder_not_granted';
      this.fail(command.task_id, code, getErrorMessage(error));
      return;
    }
    const port = await this.deps.allocatePort();
    const token = this.deps.newToken();
    const sessionHome = await this.deps.makeSessionHome(command.task_id);
    const spec = buildWsServerSpawn({
      execPath: this.deps.execPath,
      wsServerPath: this.deps.wsServerPath(command.provider),
      provider: command.provider,
      folder,
      sessionHome,
      port,
      readinessToken: token,
      shellPath: this.deps.shellPath(),
      hostEnv: this.deps.hostEnv,
      backendEnvs: command.envs,
    });
    let child: ChildLike;
    try {
      child = this.deps.spawn(spec);
    } catch (error) {
      this.fail(command.task_id, 'spawn_failed', getErrorMessage(error));
      return;
    }
    if (!(await this.deps.waitForReady(child, port, token, WS_SERVER_READY_TIMEOUT_MS))) {
      child.kill('SIGKILL');
      this.fail(command.task_id, 'spawn_failed', 'ws-server did not become ready');
      return;
    }
    const logPath = this.deps.terminalLogPath(sessionHome);
    const label = displayFolder(folder, this.deps.home);
    const session: LiveSession = {
      view: {
        taskId: command.task_id,
        agentId: command.agent_id,
        provider: command.provider,
        folder: label,
        startedAt: this.deps.now(),
      },
      relayPath: command.relay_path,
      port,
      child,
      mux: null,
      feed: this.openTerminalFeed(port, logPath),
      logPath,
      stopped: false,
    };
    this.sessions.set(command.task_id, session);
    child.onExit((code) => this.onExit(command.task_id, code));
    try {
      await this.attachTunnel(session);
    } catch (error) {
      this.stop(command.task_id);
      this.fail(command.task_id, 'spawn_failed', `relay tunnel failed: ${getErrorMessage(error)}`);
      return;
    }
    this.deps.sendControl({ type: 'session_started', task_id: command.task_id, folder: label });
    void this.openTerminal(session);
  }

  /** After the backend or network comes back, re-open every live session's tunnel. */
  async reattachTunnels(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.mux !== null) continue;
      try {
        await this.attachTunnel(session);
      } catch (error) {
        logConsoleError(LOG_TAG, `Tunnel reattach failed for ${session.view.taskId}`, error);
      }
    }
  }

  stop(taskId: string): void {
    const session = this.sessions.get(taskId);
    if (session === undefined) return;
    session.stopped = true;
    this.sessions.delete(taskId);
    session.mux?.closeAll();
    session.feed.close(1000, 'session stopped');
    session.child.kill('SIGTERM');
  }

  stopAll(): void {
    for (const taskId of this.liveTaskIds()) this.stop(taskId);
  }

  /** Re-open the Terminal window for a live session (IPC: localCode:openTerminal). */
  async openTerminalFor(taskId: string): Promise<boolean> {
    const session = this.sessions.get(taskId);
    if (session === undefined) return false;
    await this.openTerminal(session);
    return true;
  }

  private async attachTunnel(session: LiveSession): Promise<void> {
    const tunnel = await this.deps.openTunnel(session.relayPath);
    const mux = new TunnelMux(tunnel, () => this.deps.connectLocal(session.port));
    session.mux = mux;
    tunnel.on('close', () => {
      if (session.mux === mux) session.mux = null;
    });
  }

  private openTerminalFeed(port: number, logPath: string): SocketLike {
    const feed = this.deps.connectLocal(port);
    feed.on('message', (raw) => {
      const text = terminalTextFromFrame(typeof raw === 'string' ? raw : String(raw));
      if (text !== null) this.deps.appendTerminal(logPath, text);
    });
    return feed;
  }

  private async openTerminal(session: LiveSession): Promise<void> {
    const title = `Rose code agent · ${session.view.folder}`;
    try {
      await this.deps.openTerminal(buildTerminalAttachCommand({ logPath: session.logPath, title }));
    } catch (error) {
      // The session keeps running without a window; the chip still streams it.
      logConsoleError(LOG_TAG, `Could not open Terminal for ${session.view.taskId}`, error);
    }
  }

  private onExit(taskId: string, code: number | null): void {
    const session = this.sessions.get(taskId);
    if (session === undefined || session.stopped) return;
    logConsole(LOG_TAG, `Local session ${taskId} exited`, { code });
    this.sessions.delete(taskId);
    session.mux?.closeAll();
    session.feed.close(1000, 'session exited');
    this.deps.sendControl({ type: 'session_exited', task_id: taskId, code });
  }

  private fail(
    taskId: string,
    code: 'no_folder_granted' | 'folder_not_granted' | 'spawn_failed',
    error: string
  ): void {
    logConsoleError(LOG_TAG, `Local session ${taskId} failed to start (${code})`, error);
    this.deps.sendControl({ type: 'session_failed', task_id: taskId, code, error });
  }
}
