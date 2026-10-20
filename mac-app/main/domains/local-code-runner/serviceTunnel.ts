/**
 * local-code-runner — tunnel mux (service layer)
 *
 *   backend tunnel ──{op:open,ch}──► connectLocal(ws://127.0.0.1:<port>)  (one local socket per channel)
 *                  ──{op:data,ch}──► local socket.send(data)
 *                  ◀─{op:data,ch}─── local socket message
 *                  ◀─{op:close,ch}── local socket closed
 *
 * Every relay client (the worker, each chip terminal) is its own channel and
 * its own connection to ws-server.mjs, exactly like a direct E2B connection.
 */
import { parseTunnelMessage } from './service';
import type { SocketLike, TunnelFromDevice } from './types';

function text(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return String(raw);
}

export class TunnelMux {
  private readonly channels = new Map<number, SocketLike>();
  private closed = false;

  constructor(
    private readonly tunnel: SocketLike,
    private readonly connectLocal: () => SocketLike
  ) {
    tunnel.on('message', (raw) => this.onTunnelFrame(text(raw)));
    tunnel.on('close', () => this.closeAll());
    tunnel.on('error', () => this.closeAll());
  }

  get channelCount(): number {
    return this.channels.size;
  }

  private send(frame: TunnelFromDevice): void {
    if (!this.closed) this.tunnel.send(JSON.stringify(frame));
  }

  private onTunnelFrame(raw: string): void {
    const frame = parseTunnelMessage(raw);
    if (frame === null) return;
    if (frame.op === 'open') {
      this.open(frame.ch);
      return;
    }
    const local = this.channels.get(frame.ch);
    if (local === undefined) return;
    if (frame.op === 'data') {
      local.send(frame.data);
      return;
    }
    this.channels.delete(frame.ch);
    local.close(1000, 'relay client closed');
  }

  private open(ch: number): void {
    if (this.channels.has(ch)) return;
    const local = this.connectLocal();
    const pending: string[] = [];
    let ready = false;
    // Frames that arrive before the local socket opens are queued, not dropped.
    const queueingSocket: SocketLike = {
      send: (data) => (ready ? local.send(data) : pending.push(data)),
      close: (code, reason) => local.close(code, reason),
      on: (event, listener) => local.on(event, listener),
    };
    this.channels.set(ch, queueingSocket);
    local.on('open', () => {
      ready = true;
      for (const data of pending.splice(0)) local.send(data);
    });
    local.on('message', (raw) => this.send({ op: 'data', ch, data: text(raw) }));
    const onEnd = () => {
      if (this.channels.get(ch) === queueingSocket) {
        this.channels.delete(ch);
        this.send({ op: 'close', ch });
      }
    };
    local.on('close', onEnd);
    local.on('error', onEnd);
  }

  closeAll(): void {
    if (this.closed) return;
    this.closed = true;
    for (const local of this.channels.values()) local.close(1001, 'tunnel closed');
    this.channels.clear();
  }
}
