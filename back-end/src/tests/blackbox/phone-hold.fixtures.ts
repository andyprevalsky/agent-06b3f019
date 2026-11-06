/**
 * Fixtures for phone-hold.blackbox.ts: a fake Vapi + Twilio REST upstream, a
 * scriptable realtime transcriber, a scriptable human detector, and a client
 * that plays Twilio's side of a <Connect><Stream> media websocket.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { respondFakePhoneUpstream } from '../../domains/vapi/fakePhoneUpstreamResponder';

type Json = Record<string, unknown>;

export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

interface InjectedFailure {
  method: string;
  pathPattern: RegExp;
  status: number;
  body: string;
}

interface InjectedInterleave {
  method: string;
  pathPattern: RegExp;
  action: () => Promise<void>;
}

/** Vapi `/call` and Twilio `Calls` endpoints, enough for the hold lifecycle. */
export class FakeUpstream {
  readonly requests: RecordedRequest[] = [];
  readonly vapiCalls = new Map<string, Json>();
  readonly twilioStatuses = new Map<string, string>();
  private readonly failures: InjectedFailure[] = [];
  private readonly interleaves: InjectedInterleave[] = [];
  readonly interleaveErrors: unknown[] = [];
  private server: http.Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const recorded = {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          body: Buffer.concat(chunks).toString('utf8'),
        };
        this.requests.push(recorded);
        void this.interleave(recorded).then(
          () => {
            const [status, body] = this.respond(recorded);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
          },
          (error: unknown) => {
            this.interleaveErrors.push(error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'racing writer failed' }));
          }
        );
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** The next request matching method + path pattern gets this error response. */
  failNext(method: string, pathPattern: RegExp, status: number, body = 'injected failure'): void {
    this.failures.push({ method, pathPattern, status, body });
  }

  /** The next matching request is answered only after `action` finishes (a racing writer). */
  beforeNext(method: string, pathPattern: RegExp, action: () => Promise<void>): void {
    this.interleaves.push({ method, pathPattern, action });
  }

  private async interleave(request: RecordedRequest): Promise<void> {
    const index = this.interleaves.findIndex(
      (entry) => entry.method === request.method && entry.pathPattern.test(request.path)
    );
    if (index < 0) return;
    const [entry] = this.interleaves.splice(index, 1);
    await entry.action();
  }

  vapiCreates(): Json[] {
    return this.requests
      .filter((request) => request.method === 'POST' && request.path === '/call')
      .map((request) => JSON.parse(request.body) as Json);
  }

  twilioCreates(): URLSearchParams[] {
    return this.requests
      .filter((request) => request.method === 'POST' && request.path.endsWith('/Calls.json'))
      .map((request) => new URLSearchParams(request.body));
  }

  twilioUpdates(callSid: string): URLSearchParams[] {
    return this.requests
      .filter((request) => request.method === 'POST' && request.path.endsWith(`/${callSid}.json`))
      .map((request) => new URLSearchParams(request.body));
  }

  private respond(request: RecordedRequest): [number, unknown] {
    const failureIndex = this.failures.findIndex(
      (failure) => failure.method === request.method && failure.pathPattern.test(request.path)
    );
    if (failureIndex >= 0) {
      const [failure] = this.failures.splice(failureIndex, 1);
      return [failure.status, { error: failure.body }];
    }
    return respondFakePhoneUpstream(this, request);
  }
}

export interface TranscriberHandlersLike {
  onCommitted: (text: string) => void;
  onClosed: (error?: Error) => void;
}

/** A realtime STT socket the test drives: it reports what it was sent and commits on demand. */
export class FakeTranscriber {
  readonly sent: Buffer[] = [];
  closed = false;

  constructor(private readonly handlers: TranscriberHandlersLike) {}

  sendAudio = (chunk: Buffer): void => {
    this.sent.push(chunk);
  };

  close = (): void => {
    this.closed = true;
  };

  commit(text: string): void {
    this.handlers.onCommitted(text);
  }

  drop(error: Error): void {
    this.handlers.onClosed(error);
  }
}

export class FakeTranscribers {
  readonly created: FakeTranscriber[] = [];

  factory = (handlers: TranscriberHandlersLike): FakeTranscriber => {
    const transcriber = new FakeTranscriber(handlers);
    this.created.push(transcriber);
    return transcriber;
  };

  last(): FakeTranscriber | undefined {
    return this.created[this.created.length - 1];
  }
}

export interface DetectorCall {
  earlierUtterances: string[];
  latestUtterance: string;
}

/** Detector double: utterances registered as live people are classified live. */
export class ScriptedDetector {
  readonly calls: DetectorCall[] = [];
  private readonly livePeople = new Set<string>();

  markLivePerson(utterance: string): void {
    this.livePeople.add(utterance);
  }

  detect = async (input: DetectorCall): Promise<{ live_human: boolean; reason: string }> => {
    this.calls.push({
      earlierUtterances: [...input.earlierUtterances],
      latestUtterance: input.latestUtterance,
    });
    const live = this.livePeople.has(input.latestUtterance);
    return { live_human: live, reason: live ? 'scripted live person' : 'scripted hold audio' };
  };
}

export function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Stream URL, custom parameters and fallback redirect from a hold <Connect><Stream> TwiML. */
export function parseHoldTwiml(twiml: string): {
  streamUrl: string;
  parameters: Record<string, string>;
  redirectUrl: string;
} {
  const streamUrl = /<Stream url="([^"]+)">/.exec(twiml)?.[1] ?? '';
  const parameters: Record<string, string> = {};
  for (const match of twiml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)) {
    parameters[unescapeXml(match[1])] = unescapeXml(match[2]);
  }
  const redirectUrl = /<Redirect method="POST">([^<]+)<\/Redirect>/.exec(twiml)?.[1] ?? '';
  return { streamUrl: unescapeXml(streamUrl), parameters, redirectUrl: unescapeXml(redirectUrl) };
}

/** Twilio's side of a media stream: start (with custom parameters), media frames, stop. */
export class TwilioMediaStreamClient {
  readonly closed: Promise<number>;
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.closed = new Promise((resolve) => this.socket.on('close', (code) => resolve(code)));
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
    this.socket.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  }

  start(callSid: string, customParameters: Record<string, string>): void {
    this.socket.send(
      JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        start: { streamSid: `MZ${randomUUID()}`, callSid, customParameters },
      })
    );
  }

  /** One 20 ms μ-law frame (160 bytes), as Twilio sends them. */
  sendFrame(fill = 0xff): void {
    this.socket.send(
      JSON.stringify({
        event: 'media',
        media: { track: 'inbound', payload: Buffer.alloc(160, fill).toString('base64') },
      })
    );
  }

  stop(): void {
    this.socket.send(JSON.stringify({ event: 'stop' }));
  }

  close(): void {
    this.socket.close();
  }
}

export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<T> => {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return poll();
  };
  return poll();
}
