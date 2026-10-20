/**
 * Wire protocol between the backend and the Rose Mac app for local code agents
 * (C14). The Mac app's `main/domains/local-code-runner` speaks the same shapes.
 *
 *   Mac app (main)                       Backend                         Worker / FE chip
 *   ──────────────                       ───────                         ────────────────
 *   control WS  ──────────────────────▶  /api/local-devices/control      (one per Mac app)
 *     ◀── start_session / stop_session
 *     ──▶ hello / session_started / session_failed / session_exited
 *   tunnel WS   ──────────────────────▶  /api/local-code-relay/:task/device   (one per session)
 *     ◀── {op:open|data|close, ch}  ──▶ {op:data|close, ch}
 *                                        /api/local-code-relay/:task?token=  ◀── ws-server protocol
 *   ws-server.mjs on 127.0.0.1:<port>  ◀─ one local WS per relay channel (worker, chip viewers)
 *
 * Every relay client (the worker's agentic loop, each FE chip terminal) gets
 * its own channel, which the Mac maps to its own local connection to the same
 * ws-server — exactly what a direct E2B connection gets. Channels are scoped
 * to one task; nothing is shared per user (10k-agent rule).
 */

export const LOCAL_DEVICE_CONTROL_PATH = '/api/local-devices/control';
export const LOCAL_CODE_RELAY_PREFIX = '/api/local-code-relay/';
export const LOCAL_DEVICE_ID_HEADER = 'x-rose-device-id';

export type LocalCodeProvider = 'claude' | 'codex';

/** Backend → Mac app over the control channel. */
export type ControlToDevice =
  | {
      type: 'start_session';
      task_id: string;
      agent_id: string;
      provider: LocalCodeProvider;
      /** Absolute path the agent asked for; null = the Mac's default granted folder. */
      folder: string | null;
      /** Environment for ws-server.mjs (goal, model, the user's own CLI credential). */
      envs: Record<string, string>;
      /** Path (on the backend origin) of this session's tunnel leg. */
      relay_path: string;
    }
  | { type: 'stop_session'; task_id: string };

/** Mac app → backend over the control channel. */
export type ControlFromDevice =
  | { type: 'hello'; sessions: string[] }
  | {
      type: 'session_started';
      task_id: string;
      /** Display path of the granted folder, home-abbreviated (e.g. "~/Developer/rose"). */
      folder: string;
    }
  | {
      type: 'session_failed';
      task_id: string;
      /** `no_folder_granted` and `folder_not_granted` map to exact tool errors. */
      code: 'no_folder_granted' | 'folder_not_granted' | 'spawn_failed';
      error: string;
    }
  | { type: 'session_exited'; task_id: string; code: number | null };

/** Backend → Mac app over a session tunnel. */
export type TunnelToDevice =
  | { op: 'open'; ch: number }
  | { op: 'data'; ch: number; data: string }
  | { op: 'close'; ch: number };

/** Mac app → backend over a session tunnel. */
export type TunnelFromDevice =
  { op: 'data'; ch: number; data: string } | { op: 'close'; ch: number };

export function relayDevicePath(taskId: string): string {
  return `${LOCAL_CODE_RELAY_PREFIX}${taskId}/device`;
}

export function relayClientPath(taskId: string): string {
  return `${LOCAL_CODE_RELAY_PREFIX}${taskId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseControlFromDevice(raw: string): ControlFromDevice | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'hello':
      return Array.isArray(value.sessions) && value.sessions.every((s) => typeof s === 'string')
        ? { type: 'hello', sessions: value.sessions }
        : null;
    case 'session_started':
      return typeof value.task_id === 'string' && typeof value.folder === 'string'
        ? { type: 'session_started', task_id: value.task_id, folder: value.folder }
        : null;
    case 'session_failed':
      return typeof value.task_id === 'string' &&
        (value.code === 'no_folder_granted' ||
          value.code === 'folder_not_granted' ||
          value.code === 'spawn_failed')
        ? {
            type: 'session_failed',
            task_id: value.task_id,
            code: value.code,
            error: typeof value.error === 'string' ? value.error : '',
          }
        : null;
    case 'session_exited':
      return typeof value.task_id === 'string'
        ? {
            type: 'session_exited',
            task_id: value.task_id,
            code: typeof value.code === 'number' ? value.code : null,
          }
        : null;
    default:
      return null;
  }
}

export function parseTunnelFromDevice(raw: string): TunnelFromDevice | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.ch !== 'number' || !Number.isInteger(value.ch)) return null;
  if (value.op === 'data' && typeof value.data === 'string') {
    return { op: 'data', ch: value.ch, data: value.data };
  }
  if (value.op === 'close') return { op: 'close', ch: value.ch };
  return null;
}
