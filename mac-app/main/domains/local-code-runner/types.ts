/**
 * local-code-runner — types layer
 *
 * Runs code agents on this Mac (rose-builds-rose.md C14): the same
 * ws-server.mjs the E2B templates run, inside a folder the user granted,
 * relayed to the Rose backend. Wire shapes mirror
 * back-end/src/providers/localDevices/protocol.ts.
 */

import type {
  LocalCodeFolderGrant,
  LocalCodeSessionView,
  LocalCodeStatus as SharedLocalCodeStatus,
} from '../../../shared/types/ipc';

export type LocalCodeProvider = 'claude' | 'codex';

/** A folder the user shared with Rose. Local sessions never run outside one. */
export type FolderGrant = LocalCodeFolderGrant;
export type LocalSessionView = LocalCodeSessionView;
/** What the renderer (This Mac switch, folder-grant screens) reads over IPC. */
export type LocalCodeStatus = SharedLocalCodeStatus;

export interface LocalDeviceIdentity {
  deviceId: string;
  name: string;
}

export interface StartSessionCommand {
  type: 'start_session';
  task_id: string;
  agent_id: string;
  provider: LocalCodeProvider;
  folder: string | null;
  envs: Record<string, string>;
  relay_path: string;
}

export type ControlToDevice = StartSessionCommand | { type: 'stop_session'; task_id: string };

export type SessionFailureCode = 'no_folder_granted' | 'folder_not_granted' | 'spawn_failed';

export type ControlFromDevice =
  | { type: 'hello'; sessions: string[] }
  | { type: 'session_started'; task_id: string; folder: string }
  | { type: 'session_failed'; task_id: string; code: SessionFailureCode; error: string }
  | { type: 'session_exited'; task_id: string; code: number | null };

export type TunnelToDevice =
  | { op: 'open'; ch: number }
  | { op: 'data'; ch: number; data: string }
  | { op: 'close'; ch: number };

export type TunnelFromDevice =
  { op: 'data'; ch: number; data: string } | { op: 'close'; ch: number };

/** A spawned ws-server process. */
export interface ChildLike {
  kill: (signal?: NodeJS.Signals) => void;
  onExit: (listener: (code: number | null) => void) => void;
}

/** A process to spawn (argv-style; no shell). */
export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** A program to exec once (argv-style; no shell). */
export interface ExecSpec {
  file: string;
  args: string[];
}

/** Minimal socket surface the tunnel mux needs (ws.WebSocket satisfies it). */
export interface SocketLike {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (
    event: 'message' | 'close' | 'error' | 'open',
    listener: (...args: unknown[]) => void
  ) => void;
}
