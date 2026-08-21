export interface CdpCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export type CdpResponder = (command: CdpCommand) => Record<string, unknown>;

/** Small synchronous CDP transport used by browser protocol unit tests. */
export class FakeCdpWebSocket extends EventTarget {
  static responder: CdpResponder = () => ({ result: {} });
  static instances: FakeCdpWebSocket[] = [];

  readonly sent: CdpCommand[] = [];
  closed = false;

  constructor(readonly url: string) {
    super();
    FakeCdpWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(raw: string): void {
    const command = JSON.parse(raw) as CdpCommand;
    this.sent.push(command);
    const response = FakeCdpWebSocket.responder(command);
    queueMicrotask(() => this.message({ id: command.id, ...response }));
  }

  close(): void {
    this.closed = true;
  }

  message(payload: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  static reset(responder: CdpResponder): void {
    FakeCdpWebSocket.instances = [];
    FakeCdpWebSocket.responder = responder;
  }
}

export function installFakeWebSocket(): () => void {
  const original = globalThis.WebSocket;
  Object.assign(globalThis, { WebSocket: FakeCdpWebSocket });
  return () => Object.assign(globalThis, { WebSocket: original });
}
