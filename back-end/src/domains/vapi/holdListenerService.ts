/**
 * Hold listener: one websocket per parked call. Twilio streams the callee's
 * μ-law audio here; committed transcripts go to the human detector one at a
 * time, and the first live person re-enters the call.
 *
 *   Twilio <Stream> ──media──▶ batch 200 ms ──▶ realtime STT ──committed──▶ handleHoldUtterance
 *        │                                        ▲ reconnect w/ backoff        │
 *        └──stop/close──▶ cleanup                 └────────────────────────────┘ 'resumed' → stop
 */
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  HOLD_MAX_SECONDS,
  HOLD_STREAM_PATH,
  HOLD_STT_CHUNK_MS,
  resolveHoldRuntimeConfig,
  type HoldRuntimeConfig,
} from './config';
import { detectLiveHuman, type HumanDetector } from './holdDetectorService';
import { acceptHoldStream, handleHoldUtterance } from './holdService';
import { expireHold, openHold } from './holdStatusService';
import {
  createElevenLabsTranscriberFactory,
  type RealtimeTranscriber,
  type TranscriberFactory,
} from './holdSttService';
import { verifyHoldSessionToken } from './holdTelephonyService';
import { createLogger } from '../../providers/logger';

const log = createLogger('VapiHoldListener');

/** 8 kHz μ-law: 8 bytes per millisecond. */
const STT_CHUNK_BYTES = HOLD_STT_CHUNK_MS * 8;
const STT_RECONNECT_MAX_DELAY_MS = 30_000;

export interface HoldListenerDeps {
  resolveConfig: () => HoldRuntimeConfig | null;
  transcriberFactory: (config: HoldRuntimeConfig) => TranscriberFactory;
  detector: HumanDetector;
}

const DEFAULT_DEPS: HoldListenerDeps = {
  resolveConfig: () => resolveHoldRuntimeConfig(),
  transcriberFactory: (config) => createElevenLabsTranscriberFactory(config.elevenLabsApiKey),
  detector: detectLiveHuman,
};

interface TwilioStreamEvent {
  event?: string;
  start?: { callSid?: string; customParameters?: Record<string, string> };
  media?: { payload?: string };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** State of one parked call's listener; lives only as long as its Twilio stream. */
class HoldStreamListener {
  private sessionId = '';
  private transcriber: RealtimeTranscriber | null = null;
  private audio: Buffer[] = [];
  private audioBytes = 0;
  private utterances: Promise<void> = Promise.resolve();
  private reconnectDelayMs = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private done = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly config: HoldRuntimeConfig,
    private readonly deps: HoldListenerDeps
  ) {}

  async start(event: TwilioStreamEvent): Promise<void> {
    const params = event.start?.customParameters ?? {};
    const sessionId = params.session ?? '';
    if (!verifyHoldSessionToken(this.config.tokenSecret, sessionId, params.token)) {
      log.warn('Hold stream rejected: bad session token');
      this.socket.close(1008);
      return;
    }
    const session = await acceptHoldStream(sessionId);
    const hold = session === null ? undefined : openHold(session);
    if (hold === undefined || this.done) {
      log.warn('Hold stream rejected: session is not on hold', { session_id: sessionId });
      this.socket.close(1008);
      return;
    }
    this.sessionId = sessionId;
    const elapsedMs = Date.now() - Date.parse(hold.startedAt);
    const remainingMs = Math.max(0, HOLD_MAX_SECONDS * 1000 - elapsedMs);
    this.expiryTimer = setTimeout(() => this.expire(), remainingMs);
    this.openTranscriber();
    log.info('Hold stream listening', {
      session_id: sessionId,
      agent_id: session?.agentId,
      remaining_seconds: Math.round(remainingMs / 1000),
    });
  }

  media(event: TwilioStreamEvent): void {
    const payload = event.media?.payload;
    if (this.done || this.sessionId === '' || typeof payload !== 'string') return;
    const chunk = Buffer.from(payload, 'base64');
    this.audio.push(chunk);
    this.audioBytes += chunk.length;
    if (this.audioBytes < STT_CHUNK_BYTES) return;
    const batch = Buffer.concat(this.audio);
    this.audio = [];
    this.audioBytes = 0;
    this.transcriber?.sendAudio(batch);
  }

  stop(): void {
    if (this.done) return;
    this.done = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.transcriber?.close();
    this.transcriber = null;
  }

  private openTranscriber(): void {
    if (this.done) return;
    this.transcriber = this.deps.transcriberFactory(this.config)({
      onCommitted: (text) => this.enqueueUtterance(text),
      onClosed: (error) => this.scheduleReconnect(error),
    });
  }

  private scheduleReconnect(error?: Error): void {
    this.transcriber = null;
    if (this.done) return;
    log.warn('Hold transcriber closed; reconnecting', {
      session_id: this.sessionId,
      delay_ms: this.reconnectDelayMs,
      error: error?.message,
    });
    this.reconnectTimer = setTimeout(() => this.openTranscriber(), this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, STT_RECONNECT_MAX_DELAY_MS);
  }

  private enqueueUtterance(text: string): void {
    if (this.done) return;
    this.reconnectDelayMs = 1000;
    this.utterances = this.utterances.then(async () => {
      if (this.done) return;
      try {
        const outcome = await handleHoldUtterance(
          this.config,
          this.sessionId,
          text,
          this.deps.detector
        );
        // Twilio replaces this stream when the call is redirected into the new
        // segment; closing it ourselves would fall through to the hang-up path.
        if (outcome === 'resumed' || outcome === 'ignored') this.stop();
      } catch (error) {
        log.error('Hold utterance handling failed', {
          session_id: this.sessionId,
          error: errorMessage(error),
        });
      }
    });
  }

  private expire(): void {
    const sessionId = this.sessionId;
    this.stop();
    expireHold(this.config, sessionId).catch((error: unknown) => {
      log.error('Failed to end an expired hold', {
        session_id: sessionId,
        error: errorMessage(error),
      });
    });
  }
}

function handleConnection(socket: WebSocket, deps: HoldListenerDeps): void {
  const config = deps.resolveConfig();
  if (config === null) {
    socket.close(1011);
    return;
  }
  const listener = new HoldStreamListener(socket, config, deps);
  socket.on('message', (raw) => {
    let event: TwilioStreamEvent;
    try {
      event = JSON.parse(raw.toString()) as TwilioStreamEvent;
    } catch {
      return;
    }
    if (event.event === 'start') {
      listener.start(event).catch((error: unknown) => {
        log.error('Hold stream start failed', { error: errorMessage(error) });
        socket.close(1011);
      });
    } else if (event.event === 'media') {
      listener.media(event);
    } else if (event.event === 'stop') {
      listener.stop();
    }
  });
  socket.on('close', () => listener.stop());
  socket.on('error', (error) => {
    log.warn('Hold stream socket error', { error: error.message });
    listener.stop();
  });
}

/** Accepts Twilio hold streams on the backend's HTTP server (HOLD_STREAM_PATH). */
export function attachHoldStreamServer(
  server: Server,
  deps: Partial<HoldListenerDeps> = {}
): WebSocketServer {
  const resolved: HoldListenerDeps = { ...DEFAULT_DEPS, ...deps };
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket: WebSocket) => handleConnection(socket, resolved));
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== HOLD_STREAM_PATH) {
      if (server.listenerCount('upgrade') === 1) socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });
  return wss;
}
