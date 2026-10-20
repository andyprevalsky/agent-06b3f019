/**
 * Deliver one agent-to-agent message into a running code-agent session.
 *
 *   backend ──ws──► sandbox ws-server  {type:"user_message", id, text}
 *           ◄────── {type:"user_message_ack", id, status}
 *
 * The ws-server queues the text and starts it as the CLI's next user turn
 * (Claude `--resume` / Codex `exec resume`). It dedupes by `id` for its whole
 * lifetime, so a retried send can never start a second turn. One short-lived
 * connection per message: nothing is held open per agent.
 */
import WebSocket from 'ws';

export type CodeSessionInboxStatus = 'queued' | 'duplicate' | 'rejected' | 'finished';

export interface CodeSessionInboxResult {
  status: CodeSessionInboxStatus;
  reason?: string;
}

export const CODE_SESSION_INBOX_TIMEOUT_MS = 10_000;

export async function deliverToCodeSession(
  streamUrl: string,
  message: { id: string; text: string },
  timeoutMs: number = CODE_SESSION_INBOX_TIMEOUT_MS
): Promise<CodeSessionInboxResult> {
  return new Promise<CodeSessionInboxResult>((resolve) => {
    const ws = new WebSocket(streamUrl, { handshakeTimeout: timeoutMs });
    let settled = false;
    const settle = (result: CodeSessionInboxResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners('message');
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => settle({ status: 'rejected', reason: 'code session did not acknowledge in time' }),
      timeoutMs
    );
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'user_message', id: message.id, text: message.text }));
    });
    ws.on('message', (raw: WebSocket.RawData) => {
      let parsed: { type?: unknown; id?: unknown; status?: unknown; reason?: unknown };
      try {
        parsed = JSON.parse(raw.toString()) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.type === 'exit') {
        settle({ status: 'finished', reason: 'code session has finished' });
        return;
      }
      if (parsed.type !== 'user_message_ack' || parsed.id !== message.id) return;
      const status = parsed.status;
      if (status === 'queued' || status === 'duplicate' || status === 'rejected') {
        settle({
          status,
          ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
        });
      }
    });
    ws.on('close', () => settle({ status: 'finished', reason: 'code session has finished' }));
    ws.on('error', (err: Error) =>
      settle({ status: 'rejected', reason: `code session unreachable: ${err.message}` })
    );
  });
}
