/**
 * In-process fake of the Tilion REST API for unit tests.
 *
 * test ──route(handler)──▶ FakeTilionServer (node:http on 127.0.0.1:<random>)
 *                              │ records every request (method, path, headers, body)
 *                              └ answers from the first matching handler, else 404
 *
 * Point the client at it with TILION_BASE_URL=server.baseUrl. Handlers return
 * { status, body?, headers? }; `X-Request-ID` is added to every answer as the
 * real API does.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeTilionRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface FakeTilionReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Send status and headers at once, then hold the body this long (a stalled body read). */
  bodyDelayMs?: number;
}

type Handler = (request: FakeTilionRequest) => FakeTilionReply | null | undefined;

export class FakeTilionServer {
  readonly requests: FakeTilionRequest[] = [];
  private handlers: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
  private server: Server | null = null;
  private requestCounter = 0;
  baseUrl = '';

  route(method: string, pattern: RegExp, handler: Handler): this {
    this.handlers.push({ method, pattern, handler });
    return this;
  }

  reset(): void {
    this.handlers = [];
    this.requests.length = 0;
  }

  callsTo(method: string, pattern: RegExp): FakeTilionRequest[] {
    return this.requests.filter((r) => r.method === method && pattern.test(r.path));
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try {
          body = raw === '' ? null : JSON.parse(raw);
        } catch {
          body = raw;
        }
        const request: FakeTilionRequest = {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          headers: req.headers,
          body,
        };
        // Only API traffic counts: the boxes.dev daemon probes new listeners with `HEAD /`.
        if (request.path.startsWith('/v1')) this.requests.push(request);
        const pathname = new URL(request.path, 'http://fake').pathname;
        let reply: FakeTilionReply | null | undefined = null;
        for (const entry of this.handlers) {
          if (entry.method !== request.method || !entry.pattern.test(pathname)) continue;
          reply = entry.handler(request);
          if (reply) break;
        }
        const final = reply ?? { status: 404, body: { detail: 'No such route in fake' } };
        const send = () => {
          this.requestCounter += 1;
          res.writeHead(final.status, {
            'X-Request-ID': `req${String(this.requestCounter).padStart(13, '0')}`,
            ...(final.body === undefined || final.status === 204
              ? {}
              : { 'Content-Type': 'application/json' }),
            ...final.headers,
          });
          const payload =
            final.body === undefined || final.status === 204
              ? undefined
              : JSON.stringify(final.body);
          if (!final.bodyDelayMs) {
            res.end(payload);
            return;
          }
          res.flushHeaders();
          setTimeout(() => res.end(payload), final.bodyDelayMs);
        };
        if (final.delayMs) setTimeout(send, final.delayMs);
        else send();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}

export function fakeSessionRecord(sessionId: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now() / 1000;
  return {
    session_id: sessionId,
    state: 'ready',
    mode: 'ephemeral',
    region: 'us',
    owner: 'rose',
    created_at: now,
    last_active: now,
    idle_timeout: 600,
    ttl: 3600,
    expires_at: now + 600,
    connect_url: `wss://tilion.invalid/v1/session/${sessionId}/cdp?token=cdp-secret-${sessionId}`,
    connect_expires_in: 1800,
    playwright_url: null,
    exit_id: null,
    persona: 'p',
    full_browser: false,
    geo_applied: true,
    geo_unsupported: null,
    ...overrides,
  };
}
