/**
 * Deliver a turn straight to a running code session's CLI (direct chat).
 *
 * TypeScript twin of `agents/helpers/code_session_turns.py`; both speak the
 * ws-server.mjs protocol:
 *
 *   caller ──ws──► ws-server  {type:"user_turn", id, token, text, sender}
 *          ◄──────            {type:"user_turn_ack", id, status, reason?}
 *
 * The ws-server dedupes by `id` for the life of the session, so retries never
 * write a second turn. `rejected` reasons: `relay_paused` (an agent turn while
 * the user holds the session), `session_ended`, `provider_unsupported`
 * (Codex), `unauthorized`, `invalid_text`, `invalid_id`. The control socket
 * connects with `?replay=0` so the ack never queues behind the history replay. `token` is an HMAC of the task id under
 * BACKEND_API_KEY, injected into the sandbox as CODE_SESSION_TURN_TOKEN at
 * creation: the stream URL the browser reads stays read-only.
 */
import { createHmac } from 'crypto';
import WebSocket from 'ws';
import { createLogger } from './logger';

const log = createLogger('CodeSessionTurns');

const TURN_TOKEN_CONTEXT = 'rose-code-session-turn:v1:';
const DEFAULT_TIMEOUT_MS = 10_000;

export type TurnAckStatus = 'delivered' | 'duplicate' | 'rejected' | 'unreachable';

export interface CodeTurnSettings {
  model?: string;
  effort?: string;
  speed?: 'standard' | 'fast' | 'ultrafast' | 'priority';
}

export interface CodeTurnAttachment {
  name: string;
  mime_type: string;
  base64_data: string;
}

export interface TurnDelivery {
  status: TurnAckStatus;
  reason?: string;
  effective_settings?: CodeTurnSettings;
  delivery_mode?: 'steer' | 'start';
  turn_id?: string;
}

/** Per-session write token; must match `code_session_turn_token` in agents. */
export function codeSessionTurnToken(taskId: string, secret = process.env.BACKEND_API_KEY): string {
  if (secret === undefined || secret === '') {
    throw new Error('BACKEND_API_KEY is required to address a code session');
  }
  return createHmac('sha256', secret).update(`${TURN_TOKEN_CONTEXT}${taskId}`).digest('hex');
}

/** The session URL with the ws-server's history replay disabled. */
export function controlWsUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.searchParams.set('replay', '0');
  return url.toString();
}

interface AckMessage extends Omit<TurnDelivery, 'status'> {
  type?: string;
  id?: string;
  status?: string;
  reason?: string;
  code_provider?: string;
  models?: Array<{ model: string; label: string; efforts: string[]; speeds: string[] }>;
}

function sendAndAwaitAck(
  wsUrl: string,
  payload: Record<string, unknown>,
  ackType: 'user_turn_ack' | 'hand_back_ack' | 'session_capabilities_ack',
  timeoutMs: number
): Promise<AckMessage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(controlWsUrl(wsUrl));
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.terminate();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`no ${ackType} within ${timeoutMs}ms`))),
      timeoutMs
    );
    ws.on('open', () => ws.send(JSON.stringify(payload)));
    ws.on('message', (raw: WebSocket.RawData) => {
      let data: AckMessage;
      try {
        data = JSON.parse(raw.toString()) as AckMessage;
      } catch {
        return;
      }
      if (data.type === 'exit') {
        // A finished run serves its final buffer, then exit, then closes.
        finish(() => resolve({ status: 'rejected', reason: 'session_ended' }));
        return;
      }
      if (data.type !== ackType) return;
      if (ackType === 'user_turn_ack' && data.id !== payload.id) return;
      finish(() => resolve(data));
    });
    ws.on('close', () => finish(() => resolve({ status: 'rejected', reason: 'session_ended' })));
    ws.on('error', (err: Error) => finish(() => reject(err)));
  });
}

export async function deliverUserTurnToCodeSession(params: {
  wsUrl: string;
  taskId: string;
  turnId: string;
  text: string;
  sender?: 'user' | 'agent';
  attachments?: CodeTurnAttachment[];
  settings?: CodeTurnSettings;
  timeoutMs?: number;
  attempts?: number;
}): Promise<TurnDelivery> {
  const { wsUrl, taskId, turnId, text } = params;
  const attempts = Math.max(1, params.attempts ?? 2);
  const payload = {
    type: 'user_turn',
    id: turnId,
    token: codeSessionTurnToken(taskId),
    text,
    sender: params.sender ?? 'user',
    attachments: params.attachments,
    settings: params.settings,
  };
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const ack = await sendAndAwaitAck(
        wsUrl,
        payload,
        'user_turn_ack',
        params.timeoutMs ?? DEFAULT_TIMEOUT_MS
      );
      const status: TurnAckStatus =
        ack.status === 'delivered' || ack.status === 'duplicate' ? ack.status : 'rejected';
      log.info('Code session turn acknowledged', {
        taskId,
        turnId,
        status,
        reason: ack.reason,
        attempt: String(attempt),
      });
      return {
        status,
        ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
        ...(ack.effective_settings ? { effective_settings: ack.effective_settings } : {}),
        ...(ack.delivery_mode ? { delivery_mode: ack.delivery_mode } : {}),
        ...(ack.turn_id ? { turn_id: ack.turn_id } : {}),
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn('Code session turn delivery attempt failed', {
        taskId,
        turnId,
        attempt: String(attempt),
        error: lastError.slice(0, 200),
      });
    }
  }
  return { status: 'unreachable', reason: lastError };
}

export async function handBackCodeSession(params: {
  wsUrl: string;
  taskId: string;
  timeoutMs?: number;
}): Promise<'released' | 'not_held' | 'rejected' | 'unreachable'> {
  try {
    const ack = await sendAndAwaitAck(
      params.wsUrl,
      { type: 'hand_back', token: codeSessionTurnToken(params.taskId) },
      'hand_back_ack',
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    if (ack.status === 'released' || ack.status === 'not_held') return ack.status;
    if (ack.reason === 'session_ended') return 'not_held';
    return 'rejected';
  } catch (err) {
    log.warn('Code session hand back failed', {
      taskId: params.taskId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return 'unreachable';
  }
}

/** Native provider catalog. The browser never infers capability tiers. */
export async function readCodeSessionCapabilities(params: { wsUrl: string; taskId: string }) {
  return sendAndAwaitAck(
    params.wsUrl,
    { type: 'session_capabilities', token: codeSessionTurnToken(params.taskId) },
    'session_capabilities_ack',
    DEFAULT_TIMEOUT_MS
  );
}
