/**
 * Live Tilion Cloud probe: measures the real API behaviour the Tilion browser
 * provider depends on (see docs/plans/active/tilion-browser-provider.md, lane E).
 *
 * Usage (from back-end/, reads TILION_API_KEY / TILION_BASE_URL from .env):
 *   npx tsx scripts/tilion-probe.ts                       # every check
 *   npx tsx scripts/tilion-probe.ts --only create,cdp     # selected checks
 *   npx tsx scripts/tilion-probe.ts --list                # check names
 *   npx tsx scripts/tilion-probe.ts --out /path/findings.json --budget 5000
 *
 * Every session this process creates is DELETEd in a finally block, and the run
 * ends by listing the account's live sessions to confirm none of ours remain.
 * Findings never include the API key, connect/view tokens or token-bearing URLs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const BASE_URL = (process.env.TILION_BASE_URL || 'https://back.tilion.dev').replace(/\/+$/, '');
const API_KEY = process.env.TILION_API_KEY || '';

type Json = Record<string, unknown>;
type ApiResult = {
  status: number;
  ms: number;
  body: unknown;
  headers: Record<string, string>;
  requestId: string | null;
};
type CheckFn = (ctx: ProbeContext) => Promise<Json>;

const CHECKS: Record<string, { description: string; run: CheckFn }> = {};

function check(name: string, description: string, run: CheckFn): void {
  CHECKS[name] = { description, run };
}

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

/** Strip anything token-bearing before it reaches findings or logs. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/([?&](?:token|path)=)[^&\s"]+/g, '$1<redacted>')
      .replace(/ph_(?:live|test)_[A-Za-z0-9_-]+/g, 'ph_<redacted>');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [key, inner] of Object.entries(value as Json)) {
      if (key === 'token' || key === 'credential' || key === 'image_base64' || key === 'data_url') {
        out[key] = inner == null ? inner : '<redacted>';
      } else if (key === 'content_base64' && typeof inner === 'string' && !inner.startsWith('<')) {
        out[key] = `<${inner.length} base64 chars>`;
      } else {
        out[key] = redact(inner);
      }
    }
    return out;
  }
  return value;
}

async function api(
  method: string,
  route: string,
  body?: unknown,
  options: { timeoutMs?: number; headers?: Record<string, string>; auth?: boolean } = {}
): Promise<ApiResult> {
  const started = Date.now();
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.auth !== false) headers.Authorization = `Bearer ${API_KEY}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 500);
  }
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  return {
    status: response.status,
    ms: Date.now() - started,
    body: parsed,
    headers: responseHeaders,
    requestId: response.headers.get('x-request-id'),
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const started = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - started, value };
  } catch (error) {
    return {
      ms: Date.now() - started,
      error: String((error as Error).message ?? error).slice(0, 400),
    };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bound any step so a hung remote call can never skip the release in finally. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

class ProbeContext {
  readonly created = new Set<string>();
  readonly released = new Set<string>();

  /** Append-only ledger of every created id, so `--cleanup` can release sessions from a killed run. */
  constructor(private readonly ledger: string) {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
  }

  private record(event: 'created' | 'released', sessionId: string): void {
    fs.appendFileSync(
      this.ledger,
      `${JSON.stringify({ event, sessionId, at: new Date().toISOString(), pid: process.pid })}\n`
    );
  }

  async createSession(
    body: Json = {},
    extraHeaders: Record<string, string> = {}
  ): Promise<ApiResult & { sessionId?: string; connectUrl?: string }> {
    const result = await api('POST', '/v1/session', body, {
      headers: extraHeaders,
      timeoutMs: 120_000,
    });
    const parsed = result.body as Json | null;
    const sessionId = typeof parsed?.session_id === 'string' ? parsed.session_id : undefined;
    if (sessionId) {
      this.created.add(sessionId);
      this.record('created', sessionId);
    }
    const connectUrl = typeof parsed?.connect_url === 'string' ? parsed.connect_url : undefined;
    return { ...result, sessionId, connectUrl };
  }

  async release(sessionId: string): Promise<ApiResult> {
    const result = await api('DELETE', `/v1/session/${sessionId}`, undefined, {
      timeoutMs: 60_000,
    });
    if (result.status === 204 || result.status === 404 || result.status === 410) {
      this.released.add(sessionId);
      this.record('released', sessionId);
    }
    return result;
  }

  async releaseAll(): Promise<string[]> {
    const failures: string[] = [];
    for (const sessionId of this.created) {
      if (this.released.has(sessionId)) continue;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await this.release(sessionId);
          if (this.released.has(sessionId)) break;
          log('release retry', sessionId, result.status);
        } catch (error) {
          log('release error', sessionId, String(error));
        }
        await sleep(1000 * (attempt + 1));
      }
      if (!this.released.has(sessionId)) failures.push(sessionId);
    }
    return failures;
  }
}

async function connectPlaywright(
  connectUrl: string
): Promise<{ browser: Browser; page: Page; cdp: CDPSession }> {
  const browser = await chromium.connectOverCDP(connectUrl, { timeout: 60_000 });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  return { browser, page, cdp };
}

/** Open a raw CDP socket and report how the server treats it (accept, close code, handshake error). */
function rawSocketOutcome(url: string, holdMs: number): Promise<Json> {
  return new Promise((resolve) => {
    const started = Date.now();
    const ws = new WebSocket(url);
    let opened = false;
    let settled = false;
    let firstReply: unknown = null;
    const finish = (outcome: Json) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
      resolve({ ...outcome, opened, ms: Date.now() - started, firstReply });
    };
    const timer = setTimeout(() => finish({ outcome: 'held_open' }), holdMs);
    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    });
    ws.on('message', (data) => {
      if (firstReply == null) {
        try {
          const parsed = JSON.parse(String(data)) as Json;
          firstReply = parsed.result ? { ok: true } : redact(parsed);
        } catch {
          firstReply = String(data).slice(0, 200);
        }
      }
    });
    ws.on('close', (code, reason) =>
      finish({ outcome: 'closed', closeCode: code, closeReason: String(reason) })
    );
    ws.on('unexpected-response', (_req, res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += String(chunk);
      });
      res.on('end', () =>
        finish({
          outcome: 'handshake_refused',
          httpStatus: res.statusCode,
          body: redact(text.slice(0, 400)),
        })
      );
    });
    ws.on('error', (error) =>
      finish({ outcome: 'error', error: String(error.message).slice(0, 200) })
    );
  });
}

async function viewToken(sessionId: string): Promise<{ token?: string; result: ApiResult }> {
  const result = await api('POST', `/v1/session/${sessionId}/view-token`, undefined);
  const token = (result.body as Json | null)?.token;
  return { token: typeof token === 'string' ? token : undefined, result };
}

/** Count JPEG frames from the /live screencast for a window. */
function liveFrames(sessionId: string, token: string, windowMs: number): Promise<Json> {
  return new Promise((resolve) => {
    const url = `${BASE_URL.replace(/^http/, 'ws')}/v1/session/${sessionId}/live?token=${encodeURIComponent(token)}`;
    const started = Date.now();
    const ws = new WebSocket(url);
    let frames = 0;
    let firstFrameMs: number | null = null;
    let settled = false;
    const finish = (extra: Json) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
      resolve({ frames, firstFrameMs, windowMs, ...extra });
    };
    const timer = setTimeout(() => finish({ outcome: 'window_elapsed' }), windowMs);
    ws.on('message', () => {
      frames += 1;
      ws.send(JSON.stringify({ t: 'a' }));
      if (firstFrameMs == null) firstFrameMs = Date.now() - started;
    });
    ws.on('close', (code, reason) =>
      finish({ outcome: 'closed', closeCode: code, closeReason: String(reason) })
    );
    ws.on('unexpected-response', (_req, res) =>
      finish({ outcome: 'handshake_refused', httpStatus: res.statusCode })
    );
    ws.on('error', (error) =>
      finish({ outcome: 'error', error: String(error.message).slice(0, 200) })
    );
  });
}

async function ipInfo(page: Page): Promise<Json> {
  const outcome = await timed(async () => {
    await page.goto('https://ipinfo.io/json', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const text = await page.evaluate(() => document.body.innerText);
    const parsed = JSON.parse(text) as Json;
    return {
      ip: parsed.ip,
      country: parsed.country,
      region: parsed.region,
      city: parsed.city,
      org: parsed.org,
      timezone: parsed.timezone,
    };
  });
  return outcome.value
    ? { ...outcome.value, ms: outcome.ms }
    : { error: outcome.error, ms: outcome.ms };
}

async function browserLocale(page: Page): Promise<Json> {
  return page.evaluate(() => ({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    language: navigator.language,
    languages: navigator.languages,
    timezoneOffsetMin: new Date().getTimezoneOffset(),
  }));
}

function summarizeCreate(result: ApiResult): Json {
  const body = (result.body ?? {}) as Json;
  return {
    status: result.status,
    ms: result.ms,
    requestId: result.requestId,
    fields: Object.keys(body).sort(),
    body: redact(body),
  };
}

// ---------------------------------------------------------------- checks

check(
  'create',
  'create response fields/latency; connectOverCDP; second CDP client (4409?)',
  async (ctx) => {
    const created = await ctx.createSession(
      { idle_timeout: 120, ttl: 600 },
      { 'Idempotency-Key': `rose-probe-${Date.now()}` }
    );
    const out: Json = { create: summarizeCreate(created) };
    if (!created.sessionId || !created.connectUrl) return out;
    try {
      const attach = await timed(() => connectPlaywright(created.connectUrl!));
      out.connectOverCdpMs = attach.ms;
      if (!attach.value) {
        out.connectOverCdpError = attach.error;
        return out;
      }
      const { browser, page } = attach.value;
      out.contexts = browser.contexts().length;
      out.pagesInDefaultContext = browser.contexts()[0]?.pages().length ?? 0;
      out.firstGoto = await timed(() =>
        page
          .goto('https://example.com/', { waitUntil: 'domcontentloaded' })
          .then(() => page.title())
      );
      out.secondGoto = await timed(() =>
        page
          .goto('https://example.org/', { waitUntil: 'domcontentloaded' })
          .then(() => page.title())
      );
      out.secondCdpClient = await rawSocketOutcome(created.connectUrl, 5_000);
      out.firstClientAfterSecond = await timed(() => page.evaluate(() => location.href));
      out.firstClientConnected = browser.isConnected();
      await browser.close();
      // After the first client disconnects, can a new client attach with the same token?
      out.reattachSameToken = await rawSocketOutcome(created.connectUrl, 3_000);
      const connect = await api('GET', `/v1/session/${created.sessionId}/connect`);
      out.connectRoute = { status: connect.status, ms: connect.ms, body: redact(connect.body) };
      const reattach = await timed(() => connectPlaywright(created.connectUrl!));
      out.playwrightReattachMs = reattach.ms;
      out.playwrightReattachError = reattach.error ?? null;
      if (reattach.value) {
        out.reattachSeesUrl = await reattach.value.page.evaluate(() => location.href);
        await reattach.value.browser.close();
      }
    } finally {
      await ctx.release(created.sessionId);
    }
    return out;
  }
);

check(
  'rest-while-cdp',
  'REST screenshot/act/files.fetch with a CDP client attached: block time and outcome',
  async (ctx) => {
    const created = await ctx.createSession({ idle_timeout: 180, ttl: 900 });
    const out: Json = { create: { status: created.status, ms: created.ms } };
    if (!created.sessionId || !created.connectUrl) return { ...out, body: redact(created.body) };
    const sid = created.sessionId;
    try {
      const { browser, page } = await connectPlaywright(created.connectUrl);
      await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
      const shot = await api(
        'POST',
        `/v1/session/${sid}/screenshot`,
        { format: 'jpeg', quality: 50 },
        { timeoutMs: 75_000 }
      ).catch(
        (e) => ({ status: -1, ms: -1, body: String(e), requestId: null, headers: {} }) as ApiResult
      );
      out.screenshotWhileAttached = { status: shot.status, ms: shot.ms, body: redact(shot.body) };
      const act = await api(
        'POST',
        `/v1/session/${sid}/act`,
        { action: 'scroll', dy: 200 },
        { timeoutMs: 75_000 }
      ).catch(
        (e) => ({ status: -1, ms: -1, body: String(e), requestId: null, headers: {} }) as ApiResult
      );
      out.actWhileAttached = { status: act.status, ms: act.ms, body: redact(act.body) };
      const file = await api(
        'POST',
        `/v1/session/${sid}/files/fetch`,
        { url: 'https://example.com/' },
        { timeoutMs: 75_000 }
      ).catch(
        (e) => ({ status: -1, ms: -1, body: String(e), requestId: null, headers: {} }) as ApiResult
      );
      out.filesFetchWhileAttached = { status: file.status, ms: file.ms, body: redact(file.body) };
      const status = await api('GET', `/v1/session/${sid}/status`);
      out.statusWhileAttached = { status: status.status, ms: status.ms };
      out.cdpStillWorks = await timed(() => page.evaluate(() => document.title));
      out.cdpConnected = browser.isConnected();
      await browser.close();
      await sleep(1000);
      const shot2 = await api('POST', `/v1/session/${sid}/screenshot`, {
        format: 'jpeg',
        quality: 50,
      });
      out.screenshotAfterDetach = {
        status: shot2.status,
        ms: shot2.ms,
        sizeB64: (shot2.body as Json | null)?.size_b64,
      };
      const act2 = await api('POST', `/v1/session/${sid}/act`, { action: 'scroll', dy: 200 });
      out.actAfterDetach = { status: act2.status, ms: act2.ms, body: redact(act2.body) };
      const file2 = await api('POST', `/v1/session/${sid}/files/fetch`, {
        url: 'https://example.com/',
      });
      out.filesFetchAfterDetach = { status: file2.status, ms: file2.ms, body: redact(file2.body) };
    } finally {
      await ctx.release(sid);
    }
    return out;
  }
);

check(
  'status-liveview',
  '/status fields; view-token; live-view framing headers; /live while CDP attached',
  async (ctx) => {
    const created = await ctx.createSession({ idle_timeout: 120, ttl: 600 });
    const out: Json = {};
    if (!created.sessionId || !created.connectUrl) return { create: summarizeCreate(created) };
    const sid = created.sessionId;
    try {
      const status = await api('GET', `/v1/session/${sid}/status`);
      out.statusLive = {
        status: status.status,
        fields: Object.keys((status.body ?? {}) as Json).sort(),
        body: redact(status.body),
      };
      const vt = await viewToken(sid);
      out.viewToken = { status: vt.result.status, ms: vt.result.ms, body: redact(vt.result.body) };
      if (vt.token) {
        const html = await api(
          'GET',
          `/v1/session/${sid}/live-view?token=${encodeURIComponent(vt.token)}`,
          undefined,
          { auth: false }
        );
        out.liveViewPage = {
          status: html.status,
          contentType: html.headers['content-type'] ?? null,
          xFrameOptions: html.headers['x-frame-options'] ?? null,
          contentSecurityPolicy: html.headers['content-security-policy'] ?? null,
          crossOriginOpenerPolicy: html.headers['cross-origin-opener-policy'] ?? null,
          crossOriginEmbedderPolicy: html.headers['cross-origin-embedder-policy'] ?? null,
          crossOriginResourcePolicy: html.headers['cross-origin-resource-policy'] ?? null,
          permissionsPolicy: html.headers['permissions-policy'] ?? null,
          bytes:
            typeof html.body === 'string'
              ? html.body.length
              : JSON.stringify(html.body ?? '').length,
        };
        const noToken = await api('GET', `/v1/session/${sid}/live-view`, undefined, {
          auth: false,
        });
        out.liveViewNoToken = { status: noToken.status, body: redact(noToken.body) };
        const nav = await api('POST', `/v1/session/${sid}/navigate`, {
          url: 'https://example.com/',
        });
        out.restNavigate = {
          status: nav.status,
          ms: nav.ms,
          fields: Object.keys((nav.body ?? {}) as Json).sort(),
        };
        out.liveWithoutCdp = await liveFrames(sid, vt.token, 8_000);
        const { browser, page } = await connectPlaywright(created.connectUrl);
        await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
        out.liveWithCdpAttachedStatic = await liveFrames(sid, vt.token, 6_000);
        await page.evaluate(() => {
          let n = 0;
          setInterval(() => {
            n += 1;
            document.body.style.background = n % 2 ? '#f0c' : '#0cf';
            document.title = `tick ${n}`;
          }, 200);
        });
        out.liveWithCdpAttachedAnimated = await liveFrames(sid, vt.token, 6_000);
        out.cdpAfterLive = await timed(() => page.evaluate(() => document.title));
        // Does a viewer's input reach the page while CDP is attached?
        await browser.close();
        const vt2 = await viewToken(sid);
        out.secondViewTokenDiffers = vt2.token !== vt.token;
      }
    } finally {
      const del = await ctx.release(sid);
      out.delete = { status: del.status, location: del.headers.location ?? null };
      const status = await api('GET', `/v1/session/${sid}/status`);
      out.statusAfterDelete = { status: status.status, body: redact(status.body) };
    }
    return out;
  }
);

check(
  'ttl-idle-delete',
  'max ttl (422 max_ttl); idle_timeout with quiet CDP attached; DELETE 204/204/410; sessions, regions',
  async (ctx) => {
    const out: Json = {};
    const tooLong = await ctx.createSession({ ttl: 43_200 });
    out.ttl43200 = summarizeCreate(tooLong);
    if (tooLong.sessionId) await ctx.release(tooLong.sessionId);
    const maxTtl = ((tooLong.body as Json | null)?.detail as Json | undefined)?.max_ttl;
    out.maxTtl = maxTtl ?? (tooLong.status === 201 ? 43_200 : null);

    const regions = await api('GET', '/v1/regions');
    out.regions = {
      status: regions.status,
      body: regions.body,
      registryVersion: regions.headers['x-tillion-region-registry-version'] ?? null,
    };

    // Idle timeout with a quiet, attached raw CDP socket (no traffic after the first command).
    const idle = await ctx.createSession({ idle_timeout: 20, ttl: 300 });
    if (idle.sessionId && idle.connectUrl) {
      const sid = idle.sessionId;
      const quiet = rawSocketOutcome(idle.connectUrl, 50_000);
      await sleep(40_000);
      const status = await api('GET', `/v1/session/${sid}/status`);
      out.idleQuietCdp = {
        idleTimeout: 20,
        after40s: { status: status.status, body: redact(status.body) },
        socket: await quiet,
      };
      // Idle timeout with no client at all, for comparison.
      const bare = await ctx.createSession({ idle_timeout: 15, ttl: 300 });
      if (bare.sessionId) {
        await sleep(30_000);
        const bareStatus = await api('GET', `/v1/session/${bare.sessionId}/status`);
        out.idleNoClient = {
          idleTimeout: 15,
          after30s: { status: bareStatus.status, body: redact(bareStatus.body) },
        };
        await ctx.release(bare.sessionId);
      }
      await ctx.release(sid);
    }

    const del = await ctx.createSession({ idle_timeout: 60, ttl: 300 });
    if (del.sessionId) {
      const sid = del.sessionId;
      const list = await api('GET', '/v1/sessions');
      out.sessionsList = {
        status: list.status,
        count: Array.isArray(list.body) ? list.body.length : null,
        containsOurs:
          Array.isArray(list.body) && list.body.some((s) => (s as Json).session_id === sid),
        entryFields:
          Array.isArray(list.body) && list.body[0]
            ? Object.keys(list.body[0] as Json).sort()
            : null,
      };
      const first = await ctx.release(sid);
      const second = await api('DELETE', `/v1/session/${sid}`);
      const get = await api('GET', `/v1/session/${sid}`);
      const connect = await api('GET', `/v1/session/${sid}/connect`);
      const shot = await api('POST', `/v1/session/${sid}/screenshot`, {});
      out.deleteSemantics = {
        first: { status: first.status, ms: first.ms, location: first.headers.location ?? null },
        repeat: { status: second.status, ms: second.ms },
        getAfter: { status: get.status, body: redact(get.body) },
        connectAfter: { status: connect.status },
        driveAfter: { status: shot.status },
      };
      const reconnect = await rawSocketOutcome(del.connectUrl!, 3_000);
      out.cdpHandshakeAfterDelete = reconnect;
    }
    const unknown = await api('DELETE', '/v1/session/sess_00000000000000000000000000000000');
    out.deleteUnknown = { status: unknown.status, body: redact(unknown.body) };
    return out;
  }
);

check(
  'geo-rotate',
  'geo country/state/city; geo_unsupported; rotate-ip changes exit; CDP survives; tz/locale follow geo',
  async (ctx) => {
    const out: Json = {};
    const direct = await ctx.createSession({ idle_timeout: 120, ttl: 600 });
    if (direct.sessionId && direct.connectUrl) {
      try {
        const { browser, page } = await connectPlaywright(direct.connectUrl);
        out.directExit = await ipInfo(page);
        out.directLocale = await browserLocale(page);
        await browser.close();
        // rotate-ip on a direct session, with CDP detached and then attached.
        const rotate = await api('POST', `/v1/session/${direct.sessionId}/rotate-ip`);
        out.directRotateDetached = {
          status: rotate.status,
          ms: rotate.ms,
          body: redact(rotate.body),
        };
        const again = await connectPlaywright(direct.connectUrl);
        out.directExitAfterRotate = await ipInfo(again.page);
        const rotateAttached = await api(
          'POST',
          `/v1/session/${direct.sessionId}/rotate-ip`,
          undefined,
          { timeoutMs: 75_000 }
        ).catch((e) => ({ status: -1, ms: -1, body: String(e) }) as ApiResult);
        out.directRotateAttached = {
          status: rotateAttached.status,
          ms: rotateAttached.ms,
          body: redact(rotateAttached.body),
        };
        out.cdpConnectedAfterAttachedRotate = again.browser.isConnected();
        out.directExitAfterAttachedRotate = await ipInfo(again.page);
        await again.browser.close();
      } finally {
        await ctx.release(direct.sessionId);
      }
    } else {
      out.directCreate = summarizeCreate(direct);
    }

    const geoCases: Array<[string, Json]> = [
      ['country_de', { residential: true, geo: { country: 'de' } }],
      ['state_ca', { residential: true, geo: { country: 'us', state: 'ca' } }],
      ['city_austin', { residential: true, geo: { country: 'us', state: 'tx', city: 'austin' } }],
      ['zip_10001', { residential: true, geo: { zip: '10001' } }],
      ['region_de_direct', { region: 'de' }],
    ];
    const geo: Json = {};
    for (const [name, body] of geoCases) {
      const created = await ctx.createSession({ idle_timeout: 120, ttl: 600, ...body });
      const parsed = (created.body ?? {}) as Json;
      const entry: Json = {
        request: body,
        status: created.status,
        ms: created.ms,
        geo_applied: parsed.geo_applied ?? null,
        geo_unsupported: parsed.geo_unsupported ?? null,
        exit_id: parsed.exit_id ?? null,
        region: parsed.region ?? null,
        error: created.sessionId ? null : redact(parsed),
      };
      if (created.sessionId && created.connectUrl) {
        try {
          const { browser, page } = await connectPlaywright(created.connectUrl);
          entry.exit = await ipInfo(page);
          entry.locale = await browserLocale(page);
          if (name === 'state_ca') {
            await browser.close();
            const rotate = await api(
              'POST',
              `/v1/session/${created.sessionId}/rotate-ip`,
              undefined,
              { timeoutMs: 75_000 }
            );
            entry.rotate = { status: rotate.status, ms: rotate.ms, body: redact(rotate.body) };
            const again = await connectPlaywright(created.connectUrl);
            entry.exitAfterRotate = await ipInfo(again.page);
            entry.localeAfterRotate = await browserLocale(again.page);
            await again.browser.close();
          } else {
            await browser.close();
          }
        } catch (error) {
          entry.driveError = String(error).slice(0, 300);
        } finally {
          await ctx.release(created.sessionId);
        }
      }
      geo[name] = entry;
    }
    out.geo = geo;
    return out;
  }
);

check(
  'webauthn',
  'CDP virtual authenticator: credentials.create + get; sign count advances',
  async (ctx) => {
    const created = await ctx.createSession({ idle_timeout: 120, ttl: 600 });
    if (!created.sessionId || !created.connectUrl) return { create: summarizeCreate(created) };
    const out: Json = {};
    try {
      const { browser, page, cdp } = await connectPlaywright(created.connectUrl);
      await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
      const enable = await timed(() => cdp.send('WebAuthn.enable', { enableUI: false }));
      out.enable = { ms: enable.ms, error: enable.error ?? null };
      const auth = await timed(() =>
        cdp.send('WebAuthn.addVirtualAuthenticator', {
          options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        })
      );
      out.addVirtualAuthenticator = { ms: auth.ms, error: auth.error ?? null };
      const authenticatorId = auth.value?.authenticatorId;
      out.create = await withTimeout(
        page.evaluate(async () => {
          try {
            const cred = (await navigator.credentials.create({
              publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                rp: { name: 'Rose probe', id: location.hostname },
                user: {
                  id: crypto.getRandomValues(new Uint8Array(16)),
                  name: 'probe@rose',
                  displayName: 'Probe',
                },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
                timeout: 20000,
              },
            })) as PublicKeyCredential | null;
            if (!cred) return { ok: false, error: 'null credential' };
            (window as unknown as { __probeCredId: string }).__probeCredId = cred.id;
            return { ok: true, id: cred.id, type: cred.type };
          } catch (error) {
            return { ok: false, error: String(error) };
          }
        }),
        40_000,
        'credentials.create'
      ).catch((error) => ({ ok: false, error: String(error) }));
      const credsAfterCreate = await timed(() =>
        cdp.send('WebAuthn.getCredentials', { authenticatorId: authenticatorId ?? '' })
      );
      out.signCountAfterCreate = credsAfterCreate.value?.credentials.map((c) => c.signCount) ?? {
        error: credsAfterCreate.error ?? null,
      };
      const assertion = async () =>
        page.evaluate(async () => {
          try {
            const id = (window as unknown as { __probeCredId?: string }).__probeCredId;
            const raw = id
              ? Uint8Array.from(
                  atob(id.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((id.length + 3) % 4)),
                  (c) => c.charCodeAt(0)
                )
              : null;
            const cred = (await navigator.credentials.get({
              publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                rpId: location.hostname,
                allowCredentials: raw ? [{ type: 'public-key', id: raw }] : [],
                userVerification: 'required',
                timeout: 20000,
              },
            })) as PublicKeyCredential | null;
            if (!cred) return { ok: false, error: 'null assertion' };
            const data = new Uint8Array(
              (cred.response as AuthenticatorAssertionResponse).authenticatorData
            );
            const signCount = (data[33] << 24) | (data[34] << 16) | (data[35] << 8) | data[36];
            return { ok: true, signCount };
          } catch (error) {
            return { ok: false, error: String(error) };
          }
        });
      out.get1 = await withTimeout(assertion(), 40_000, 'credentials.get').catch((error) => ({
        ok: false,
        error: String(error),
      }));
      out.get2 = await withTimeout(assertion(), 40_000, 'credentials.get').catch((error) => ({
        ok: false,
        error: String(error),
      }));
      const credsAfterGet = await timed(() =>
        cdp.send('WebAuthn.getCredentials', { authenticatorId: authenticatorId ?? '' })
      );
      out.signCountAfterGets = credsAfterGet.value?.credentials.map((c) => c.signCount) ?? {
        error: credsAfterGet.error ?? null,
      };
      out.authenticatorId = authenticatorId ? 'present' : null;
      await browser.close();
    } finally {
      await ctx.release(created.sessionId);
    }
    return out;
  }
);

const UPLOAD_PAGE = `data:text/html,<input id=f type=file multiple><pre id=o></pre><script>
document.getElementById('f').addEventListener('change',async e=>{const r=[];for(const f of e.target.files){r.push({name:f.name,size:f.size,type:f.type,head:(await f.text()).slice(0,32)})}document.getElementById('o').textContent=JSON.stringify(r)})</script>`;

check(
  'upload',
  'DOM.setFileInputFiles (local path), Playwright buffer setInputFiles, DataTransfer/blob',
  async (ctx) => {
    const created = await ctx.createSession({ idle_timeout: 120, ttl: 600 });
    if (!created.sessionId || !created.connectUrl) return { create: summarizeCreate(created) };
    const out: Json = {};
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tilion-probe-'));
    const localFile = path.join(tmp, 'probe-upload.txt');
    fs.writeFileSync(localFile, 'rose-tilion-upload-probe local path\n');
    const readResult = async (page: Page) => {
      await sleep(500);
      const text = await page.evaluate(() => document.getElementById('o')?.textContent ?? '');
      return text ? JSON.parse(text) : null;
    };
    try {
      const { browser, page, cdp } = await connectPlaywright(created.connectUrl);
      // A data: URL navigation is a common first page for local fixtures; use example.com + injected DOM if refused.
      const nav = await timed(() => page.goto(UPLOAD_PAGE));
      out.dataUrlNavigation = { ms: nav.ms, error: nav.error ?? null };
      if (nav.error) {
        await page.goto('https://example.com/');
        await page.evaluate((html) => {
          document.body.innerHTML = html
            .replace(/^data:text\/html,/, '')
            .replace(/<script>[\s\S]*<\/script>/, '');
          document.getElementById('f')!.addEventListener('change', async (e) => {
            const r = [];
            for (const f of Array.from((e.target as HTMLInputElement).files ?? []))
              r.push({
                name: f.name,
                size: f.size,
                type: f.type,
                head: (await f.text()).slice(0, 32),
              });
            document.getElementById('o')!.textContent = JSON.stringify(r);
          });
        }, UPLOAD_PAGE);
      }
      const doc = await cdp.send('DOM.getDocument', {});
      const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#f' });
      const raw = await timed(() =>
        cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [localFile] })
      );
      out.cdpSetFileInputFilesLocalPath = {
        ms: raw.ms,
        error: raw.error ?? null,
        pageSaw: await readResult(page),
      };
      const remotePath = await timed(() =>
        cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: ['/etc/hostname'] })
      );
      out.cdpSetFileInputFilesRemotePath = {
        ms: remotePath.ms,
        error: remotePath.error ?? null,
        pageSaw: await readResult(page),
      };
      const pw = await timed(() =>
        page.setInputFiles('#f', {
          name: 'probe-buffer.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('rose-tilion-upload-probe buffer\n'),
        })
      );
      out.playwrightBufferSetInputFiles = {
        ms: pw.ms,
        error: pw.error ?? null,
        pageSaw: await readResult(page),
      };
      const pwPath = await timed(() => page.setInputFiles('#f', localFile));
      out.playwrightLocalPathSetInputFiles = {
        ms: pwPath.ms,
        error: pwPath.error ?? null,
        pageSaw: await readResult(page),
      };
      const dt = await timed(() =>
        page.evaluate(() => {
          const input = document.getElementById('f') as HTMLInputElement;
          const transfer = new DataTransfer();
          transfer.items.add(
            new File(
              [new Blob(['rose-tilion-upload-probe datatransfer\n'], { type: 'text/plain' })],
              'probe-dt.txt',
              { type: 'text/plain' }
            )
          );
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return input.files.length;
        })
      );
      out.dataTransferBlob = {
        ms: dt.ms,
        error: dt.error ?? null,
        pageSaw: await readResult(page),
      };
      await browser.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      await ctx.release(created.sessionId);
    }
    return out;
  }
);

const DOWNLOAD_URL =
  'https://httpbin.org/response-headers?Content-Type=text%2Fplain&Content-Disposition=attachment%3B%20filename%3Dprobe-download.txt';

check(
  'download',
  'Browser.setDownloadBehavior + downloadWillBegin; Playwright download event; files/fetch of that URL',
  async (ctx) => {
    const created = await ctx.createSession({ idle_timeout: 120, ttl: 600 });
    if (!created.sessionId || !created.connectUrl) return { create: summarizeCreate(created) };
    const sid = created.sessionId;
    const out: Json = {};
    try {
      const { browser, page } = await connectPlaywright(created.connectUrl);
      await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
      const browserCdp = await browser.newBrowserCDPSession();
      const events: Json[] = [];
      browserCdp.on('Browser.downloadWillBegin', (e) =>
        events.push({
          event: 'downloadWillBegin',
          url: e.url,
          suggestedFilename: e.suggestedFilename,
        })
      );
      browserCdp.on('Browser.downloadProgress', (e) => {
        if (e.state !== 'inProgress')
          events.push({
            event: 'downloadProgress',
            state: e.state,
            totalBytes: e.totalBytes,
            receivedBytes: e.receivedBytes,
          });
      });
      const behavior = await timed(() =>
        browserCdp.send('Browser.setDownloadBehavior', {
          behavior: 'allowAndName',
          downloadPath: '/tmp/rose-probe-downloads',
          eventsEnabled: true,
        })
      );
      out.setDownloadBehavior = { ms: behavior.ms, error: behavior.error ?? null };
      const download = await timed(async () => {
        const wait = page.waitForEvent('download', { timeout: 30_000 });
        await page.evaluate((url) => {
          const a = document.createElement('a');
          a.href = url;
          a.download = 'probe-download.txt';
          document.body.appendChild(a);
          a.click();
        }, DOWNLOAD_URL);
        const dl = await wait;
        const failure = await dl.failure();
        const tmpPath = path.join(os.tmpdir(), `tilion-probe-dl-${Date.now()}.txt`);
        const saved = await timed(() => dl.saveAs(tmpPath));
        const size = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : null;
        if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath);
        return {
          url: dl.url(),
          suggested: dl.suggestedFilename(),
          failure,
          saveAsMs: saved.ms,
          saveAsError: saved.error ?? null,
          savedBytes: size,
        };
      });
      out.playwrightDownload = download.value ?? { error: download.error, ms: download.ms };
      await sleep(3000);
      out.cdpEvents = events;
      await browser.close();
      const fetched = await api('POST', `/v1/session/${sid}/files/fetch`, { url: DOWNLOAD_URL });
      const body = (fetched.body ?? {}) as Json;
      out.filesFetch = {
        status: fetched.status,
        ms: fetched.ms,
        filename: body.filename ?? null,
        size: body.size ?? null,
        contentType: body.content_type ?? null,
        error: fetched.status === 200 ? null : redact(body),
      };
    } finally {
      await ctx.release(sid);
    }
    return out;
  }
);

const RECAPTCHA_DEMO = 'https://www.google.com/recaptcha/api2/demo';
const TURNSTILE_DEMO = 'https://nopecha.com/demo/cloudflare';

async function captchaState(page: Page): Promise<Json> {
  return page.evaluate(() => {
    const recaptcha = document.querySelector(
      'textarea[name="g-recaptcha-response"]'
    ) as HTMLTextAreaElement | null;
    const turnstile = document.querySelector(
      'input[name="cf-turnstile-response"]'
    ) as HTMLInputElement | null;
    return {
      url: location.href,
      title: document.title,
      recaptchaTokenLength: recaptcha ? recaptcha.value.length : null,
      turnstileTokenLength: turnstile ? turnstile.value.length : null,
      iframes: Array.from(document.querySelectorAll('iframe'))
        .map((f) => (f.src || '').split('?')[0])
        .slice(0, 6),
    };
  });
}

async function creditsBalance(): Promise<number | null> {
  const credits = await api('GET', '/v1/credits');
  const balance = (credits.body as Json | null)?.balance;
  return typeof balance === 'number' ? balance : null;
}

check(
  'cdp-observe-captcha',
  'cdp_observe true vs false navigation latency; reCAPTCHA v2 + Turnstile demo solved? credits',
  async (ctx) => {
    const out: Json = {};
    for (const observe of [false, true]) {
      const created = await ctx.createSession({
        idle_timeout: 180,
        ttl: 900,
        cdp_observe: observe,
      });
      const key = observe ? 'observeOn' : 'observeOff';
      if (!created.sessionId || !created.connectUrl) {
        out[key] = summarizeCreate(created);
        continue;
      }
      const entry: Json = {};
      try {
        const { browser, page } = await connectPlaywright(created.connectUrl);
        const navs: number[] = [];
        for (const url of [
          'https://example.com/',
          'https://example.org/',
          'https://www.iana.org/help/example-domains',
        ]) {
          const nav = await timed(() => page.goto(url, { waitUntil: 'load', timeout: 45_000 }));
          navs.push(nav.error ? -1 : nav.ms);
        }
        entry.navigationMs = navs;
        for (const [name, url] of [
          ['recaptcha', RECAPTCHA_DEMO],
          ['turnstile', TURNSTILE_DEMO],
        ] as const) {
          const before = await creditsBalance();
          const nav = await timed(() => page.goto(url, { waitUntil: 'load', timeout: 45_000 }));
          const samples: Json[] = [];
          for (let i = 0; i < 6; i += 1) {
            await sleep(10_000);
            const state = await captchaState(page).catch((e) => ({
              error: String(e).slice(0, 200),
            }));
            samples.push({ t: (i + 1) * 10, ...state });
            if ((state as Json).recaptchaTokenLength || (state as Json).turnstileTokenLength) break;
          }
          await sleep(61_000 - Math.min(60_000, samples.length * 10_000)); // let the per-minute debit land before reading
          const after = await creditsBalance();
          entry[name] = {
            navMs: nav.ms,
            navError: nav.error ?? null,
            samples,
            creditsBefore: before,
            creditsAfter: after,
          };
        }
        await browser.close();
      } finally {
        await ctx.release(created.sessionId);
      }
      out[key] = entry;
    }
    return out;
  }
);

check(
  'solve-rest',
  'REST /v1/solve on reCAPTCHA v2 + Turnstile demos (after CDP detach); CDP state after; credits per solve',
  async (ctx) => {
    const out: Json = {};
    for (const [name, url] of [
      ['recaptcha', RECAPTCHA_DEMO],
      ['turnstile', TURNSTILE_DEMO],
    ] as const) {
      const created = await ctx.createSession({ idle_timeout: 180, ttl: 600 });
      if (!created.sessionId || !created.connectUrl) {
        out[name] = summarizeCreate(created);
        continue;
      }
      const entry: Json = {};
      try {
        const nav = await api(
          'POST',
          `/v1/session/${created.sessionId}/navigate`,
          { url },
          { timeoutMs: 75_000 }
        );
        entry.navigate = { status: nav.status, ms: nav.ms, body: redact(nav.body) };
        const before = await creditsBalance();
        const solve = await api(
          'POST',
          '/v1/solve',
          { session_id: created.sessionId, timeout: 50 },
          { timeoutMs: 75_000 }
        );
        entry.solve = { status: solve.status, ms: solve.ms, body: redact(solve.body) };
        const { browser, page } = await connectPlaywright(created.connectUrl);
        entry.pageAfterSolve = await captchaState(page).catch((e) => ({
          error: String(e).slice(0, 200),
        }));
        await browser.close();
        entry.creditsBeforeSolve = before;
        entry.creditsAfterSolve = await creditsBalance();
      } finally {
        await ctx.release(created.sessionId);
      }
      out[name] = entry;
    }
    return out;
  }
);

check(
  'rotate-residential',
  'residential rotate-ip: exit changes, tunnel recovers, CDP reattach; attached rotate',
  async (ctx) => {
    const created = await ctx.createSession({
      idle_timeout: 180,
      ttl: 600,
      residential: true,
      geo: { country: 'us' },
    });
    if (!created.sessionId || !created.connectUrl) return { create: summarizeCreate(created) };
    const sid = created.sessionId;
    const out: Json = {
      create: {
        status: created.status,
        ms: created.ms,
        geo_applied: (created.body as Json).geo_applied ?? null,
      },
    };
    try {
      let { browser, page } = await connectPlaywright(created.connectUrl);
      out.exitBefore = await ipInfo(page);
      await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.setItem('rose-probe', 'kept'));
      await browser.close();
      const rotate = await api('POST', `/v1/session/${sid}/rotate-ip`, undefined, {
        timeoutMs: 75_000,
      });
      out.rotateDetached = { status: rotate.status, ms: rotate.ms, body: redact(rotate.body) };
      ({ browser, page } = await connectPlaywright(created.connectUrl));
      const samples: Json[] = [];
      for (let i = 0; i < 6; i += 1) {
        const info = await ipInfo(page);
        samples.push({ afterMs: i * 3000, ...info });
        if (info.ip) break;
        await sleep(3000);
      }
      out.exitAfterRotateSamples = samples;
      await page
        .goto('https://example.com/', { waitUntil: 'domcontentloaded' })
        .catch(() => undefined);
      out.localStorageKept = await page
        .evaluate(() => localStorage.getItem('rose-probe'))
        .catch((e) => String(e).slice(0, 200));
      const attached = await api('POST', `/v1/session/${sid}/rotate-ip`, undefined, {
        timeoutMs: 75_000,
      });
      out.rotateAttached = {
        status: attached.status,
        ms: attached.ms,
        body: redact(attached.body),
      };
      out.cdpConnectedAfterAttachedRotate = browser.isConnected();
      out.exitAfterAttachedRotate = await ipInfo(page);
      await browser.close();
    } finally {
      await ctx.release(sid);
    }
    return out;
  }
);

check(
  'second-client',
  'second CDP client while attached: direct vs residential (adapter create body), idle vs busy first client',
  async (ctx) => {
    const out: Json = {};
    const variants: Array<[string, Json]> = [
      ['direct', {}],
      [
        'residential',
        { residential: true, proxy_type: 'residential', geo: { country: 'us' }, cdp_observe: true },
      ],
    ];
    for (const [name, body] of variants) {
      const created = await ctx.createSession({ idle_timeout: 120, ttl: 600, ...body });
      if (!created.sessionId || !created.connectUrl) {
        out[name] = summarizeCreate(created);
        continue;
      }
      try {
        const { browser, page } = await connectPlaywright(created.connectUrl);
        await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
        const idle = await rawSocketOutcome(created.connectUrl, 6_000);
        const busy = (async () => {
          for (let i = 0; i < 30; i += 1) await page.evaluate(() => document.title);
        })();
        const whileBusy = await rawSocketOutcome(created.connectUrl, 6_000);
        await busy;
        out[name] = { idle, whileBusy, firstStillConnected: browser.isConnected() };
        await browser.close();
      } finally {
        await ctx.release(created.sessionId);
      }
    }
    return out;
  }
);

/** Raw CDP client that records every reply and event, for gateway allow-list checks. */
async function rawCdp(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  let nextId = 0;
  const pending = new Map<number, (reply: Json) => void>();
  const events: Json[] = [];
  let closed: Json | null = null;
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as Json;
    if (typeof message.id === 'number' && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    } else if (typeof message.method === 'string') {
      events.push({ method: message.method, sessionId: message.sessionId ?? null });
    }
  });
  ws.on('close', (code, reason) => {
    closed = { code, reason: String(reason) };
  });
  const send = (method: string, params: Json = {}, sessionId?: string, timeoutMs = 15_000) =>
    new Promise<Json>((resolve) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ timeout: timeoutMs });
      }, timeoutMs);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, send, events, closed: () => closed };
}

function cdpOutcome(reply: Json): Json {
  if (reply.error) return { ok: false, error: reply.error };
  if (reply.timeout) return { ok: false, timeoutMs: reply.timeout };
  return { ok: true, result: redact(reply.result) };
}

check(
  'cdp-target',
  'Target.attachToBrowserTarget, setAutoAttach flatten, getTargets, attachToTarget flatten over one client',
  async (ctx) => {
    const out: Json = {};
    for (const [name, body] of [
      ['direct', {}],
      ['residential', { residential: true, proxy_type: 'residential', geo: { country: 'us' } }],
    ] as Array<[string, Json]>) {
      const created = await ctx.createSession({ idle_timeout: 120, ttl: 600, ...body });
      if (!created.sessionId || !created.connectUrl) {
        out[name] = summarizeCreate(created);
        continue;
      }
      const entry: Json = {};
      try {
        const cdp = await rawCdp(created.connectUrl);
        const browserTarget = await cdp.send('Target.attachToBrowserTarget');
        entry.attachToBrowserTarget = cdpOutcome(browserTarget);
        const browserSession = (browserTarget.result as Json | undefined)?.sessionId as
          string | undefined;
        entry.setAutoAttachRoot = cdpOutcome(
          await cdp.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
          })
        );
        if (browserSession) {
          entry.setAutoAttachOnBrowserSession = cdpOutcome(
            await cdp.send(
              'Target.setAutoAttach',
              { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
              browserSession
            )
          );
        }
        const targets = await cdp.send('Target.getTargets');
        entry.getTargets = cdpOutcome(targets);
        const infos = ((targets.result as Json | undefined)?.targetInfos ?? []) as Json[];
        const pageTarget = infos.find((info) => info.type === 'page');
        entry.targetTypes = infos.map((info) => info.type);
        if (pageTarget) {
          const attached = await cdp.send('Target.attachToTarget', {
            targetId: pageTarget.targetId,
            flatten: true,
          });
          entry.attachToTarget = cdpOutcome(attached);
          const pageSession = (attached.result as Json | undefined)?.sessionId as
            string | undefined;
          if (pageSession) {
            entry.runtimeEvaluateOnPageSession = cdpOutcome(
              await cdp.send(
                'Runtime.evaluate',
                { expression: 'location.href', returnByValue: true },
                pageSession
              )
            );
            entry.pageNavigateOnPageSession = cdpOutcome(
              await cdp.send('Page.navigate', { url: 'https://example.com/' }, pageSession)
            );
          }
        }
        const created2 = await cdp.send('Target.createTarget', { url: 'about:blank' });
        entry.createTarget = cdpOutcome(created2);
        await sleep(1500);
        entry.attachedToTargetEvents = cdp.events.filter(
          (event) => event.method === 'Target.attachedToTarget'
        ).length;
        entry.eventMethods = [...new Set(cdp.events.map((event) => event.method))].slice(0, 20);
        entry.socketClosed = cdp.closed();
        cdp.ws.terminate();
      } catch (error) {
        entry.error = String(error).slice(0, 300);
      } finally {
        await ctx.release(created.sessionId);
      }
      out[name] = entry;
    }
    return out;
  }
);

check(
  'storage-harvest',
  'context.storageState() after leaving the origin that set localStorage; tab URL after files/fetch',
  async (ctx) => {
    const created = await ctx.createSession({ idle_timeout: 120, ttl: 600 });
    if (!created.sessionId || !created.connectUrl) return { create: summarizeCreate(created) };
    const out: Json = {};
    const origins = (state: { origins: Array<{ origin: string }> }) =>
      state.origins.map((origin) => origin.origin);
    try {
      let { browser, page } = await connectPlaywright(created.connectUrl);
      await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.setItem('rose_probe', 'set'));
      out.onSameOrigin = origins(await browser.contexts()[0].storageState());
      await page.goto('https://www.iana.org/help/example-domains', {
        waitUntil: 'domcontentloaded',
      });
      out.afterLeavingOrigin = origins(await browser.contexts()[0].storageState());
      await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
      await browser.close();
      // Control: a fresh client (what the backend harvest is) with nothing in between.
      ({ browser, page } = await connectPlaywright(created.connectUrl));
      out.freshClientNoFetch = origins(await browser.contexts()[0].storageState());
      out.freshClientPageSeesKey = await page.evaluate(() => localStorage.getItem('rose_probe'));
      await browser.close();
      // A REST files/fetch while no client is attached: does it move the visible tab?
      const fetched = await api('POST', `/v1/session/${created.sessionId}/files/fetch`, {
        url: 'https://www.w3.org/TR/2003/REC-PNG-20031110/iso_8859-1.txt',
      });
      out.filesFetchStatus = fetched.status;
      ({ browser, page } = await connectPlaywright(created.connectUrl));
      out.tabUrlAfterFilesFetch = browser
        .contexts()[0]
        .pages()
        .map((p) => p.url());
      out.afterFilesFetch = origins(await browser.contexts()[0].storageState());
      await browser.close();
    } finally {
      await ctx.release(created.sessionId);
    }
    return out;
  }
);

check(
  'concurrency',
  'open up to the cap; next create gets 429 concurrency_limit; delete all',
  async (ctx) => {
    const out: Json = {};
    const usage = await api('GET', '/v1/usage');
    out.usage = { status: usage.status, body: redact(usage.body) };
    const before = await api('GET', '/v1/sessions');
    const preexisting = Array.isArray(before.body) ? before.body.length : 0;
    out.preexistingLiveSessions = preexisting;
    const cap = Number(
      ((usage.body as Json | null)?.concurrency_limit as number | undefined) ?? 20
    );
    const toOpen = Math.max(0, cap - preexisting);
    out.cap = cap;
    out.opening = toOpen;
    const ids: string[] = [];
    const statuses: Record<string, number> = {};
    try {
      const results = await Promise.all(
        Array.from({ length: toOpen }, () =>
          ctx
            .createSession({ idle_timeout: 60, ttl: 300 })
            .catch(
              (e) => ({ status: -1, ms: -1, body: String(e) }) as ApiResult & { sessionId?: string }
            )
        )
      );
      const latencies: number[] = [];
      for (const r of results) {
        statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
        if (r.sessionId) ids.push(r.sessionId);
        latencies.push(r.ms);
        if (r.status !== 201) out.nonCreatedSample = redact(r.body);
      }
      latencies.sort((a, b) => a - b);
      out.createStatuses = statuses;
      out.createLatencyMs = {
        p50: latencies[Math.floor(latencies.length / 2)] ?? null,
        max: latencies[latencies.length - 1] ?? null,
      };
      const over = await ctx.createSession({ idle_timeout: 60, ttl: 300 });
      out.overCap = {
        status: over.status,
        ms: over.ms,
        headers: { retryAfter: over.headers['retry-after'] ?? null },
        body: redact(over.body),
        requestId: over.requestId,
      };
      if (over.sessionId) ids.push(over.sessionId);
    } finally {
      const released = await Promise.all(ids.map((id) => ctx.release(id)));
      out.releaseStatuses = released.reduce<Record<string, number>>((acc, r) => {
        acc[String(r.status)] = (acc[String(r.status)] ?? 0) + 1;
        return acc;
      }, {});
    }
    return out;
  }
);

check(
  'runtime-enable',
  'Runtime.enable leak detection; navigator.webdriver; screenshot vs viewport (window chrome)',
  async (ctx) => {
    const created = await ctx.createSession({ idle_timeout: 120, ttl: 600 });
    if (!created.sessionId || !created.connectUrl) return { create: summarizeCreate(created) };
    const sid = created.sessionId;
    const out: Json = {};
    try {
      const { browser, page, cdp } = await connectPlaywright(created.connectUrl);
      await page.goto('https://example.com/', { waitUntil: 'load' });
      // Playwright has already sent Runtime.enable on this target; this is the classic stack-getter leak.
      out.runtimeEnableLeak = await page.evaluate(() => {
        let detected = false;
        const e = new Error('probe');
        Object.defineProperty(e, 'stack', {
          configurable: false,
          get() {
            detected = true;
            return '';
          },
        });
        console.debug(e);
        return detected;
      });
      out.fingerprint = await page.evaluate(() => ({
        webdriver: navigator.webdriver,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        inner: [window.innerWidth, window.innerHeight],
        outer: [window.outerWidth, window.outerHeight],
        screen: [screen.width, screen.height],
        devicePixelRatio: window.devicePixelRatio,
      }));
      const cdpShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const png = Buffer.from(cdpShot.data, 'base64');
      out.cdpScreenshotPx = [png.readUInt32BE(16), png.readUInt32BE(20)];
      await page
        .goto('https://bot-detector.rebrowser.net/', { waitUntil: 'load', timeout: 45_000 })
        .catch(() => undefined);
      await sleep(4000);
      out.rebrowserDetector = await page
        .evaluate(() => document.body.innerText.slice(0, 1500))
        .catch((e) => String(e).slice(0, 200));
      await page.goto('https://example.com/', { waitUntil: 'load' });
      await browser.close();
      const shot = await api('POST', `/v1/session/${sid}/screenshot`, { format: 'png' });
      const b64 = (shot.body as Json | null)?.image_base64;
      if (typeof b64 === 'string') {
        const restPng = Buffer.from(b64, 'base64');
        out.restScreenshotPx = [restPng.readUInt32BE(16), restPng.readUInt32BE(20)];
      }
      out.restScreenshot = { status: shot.status, ms: shot.ms };
    } finally {
      await ctx.release(sid);
    }
    return out;
  }
);

// ---------------------------------------------------------------- runner

/** Release every ledger id that was created but never confirmed released (only ids this CLI created). */
async function cleanupLedger(ledger: string): Promise<void> {
  if (!fs.existsSync(ledger)) {
    log('no ledger at', ledger);
    return;
  }
  const open = new Set<string>();
  for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { event: string; sessionId: string };
    if (entry.event === 'created') open.add(entry.sessionId);
    else open.delete(entry.sessionId);
  }
  const ctx = new ProbeContext(ledger);
  for (const sessionId of open) ctx.created.add(sessionId);
  const failures = await ctx.releaseAll();
  log('cleanup', JSON.stringify({ attempted: open.size, failures }));
}

function parseArgs(argv: string[]): {
  only: string[] | null;
  out: string;
  ledger: string;
  budget: number;
  list: boolean;
  cleanup: boolean;
  checkTimeoutMs: number;
} {
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const only = get('--only');
  const out = get('--out') ?? path.resolve(process.cwd(), '.context/tilion-probe-findings.json');
  return {
    only: only
      ? only
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    out,
    ledger: get('--ledger') ?? path.resolve(path.dirname(out), 'tilion-probe-sessions.jsonl'),
    budget: Number(get('--budget') ?? 5000),
    list: argv.includes('--list'),
    cleanup: argv.includes('--cleanup'),
    checkTimeoutMs: Number(get('--check-timeout-ms') ?? 420_000),
  };
}

function writeFindings(file: string, findings: Json): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(redact(findings), null, 2)}\n`);
  fs.renameSync(tmp, file);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const [name, { description }] of Object.entries(CHECKS))
      console.log(`${name.padEnd(22)} ${description}`);
    return;
  }
  if (!API_KEY) throw new Error('TILION_API_KEY is not set (back-end/.env)');
  if (args.cleanup) {
    await cleanupLedger(args.ledger);
    return;
  }
  const selected = args.only ?? Object.keys(CHECKS);
  const unknown = selected.filter((name) => !CHECKS[name]);
  if (unknown.length) throw new Error(`unknown check(s): ${unknown.join(', ')}; see --list`);

  const findings: Json = fs.existsSync(args.out)
    ? (JSON.parse(fs.readFileSync(args.out, 'utf8')) as Json)
    : {};
  const checks = (findings.checks ?? {}) as Json;
  findings.checks = checks;
  findings.baseUrl = BASE_URL;
  const ctx = new ProbeContext(args.ledger);
  const creditsStart = await creditsBalance();
  const creditsDoc = await api('GET', '/v1/credits');
  findings.creditsPriceList = redact((creditsDoc.body as Json | null)?.cost ?? null);
  log('credits at start', creditsStart);
  let stopped = false;
  const onSignal = () => {
    if (stopped) return;
    stopped = true;
    log('signal received; releasing sessions');
    void ctx.releaseAll().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    for (const name of selected) {
      if (stopped) break;
      const spent =
        creditsStart != null ? creditsStart - ((await creditsBalance()) ?? creditsStart) : 0;
      if (spent >= args.budget) {
        log(`budget ${args.budget} reached (${spent} spent); skipping ${name}`);
        checks[name] = { skipped: 'budget', spent };
        continue;
      }
      log('check start', name);
      const started = Date.now();
      let result: Json;
      try {
        result = await withTimeout(CHECKS[name].run(ctx), args.checkTimeoutMs, `check ${name}`);
      } catch (error) {
        result = { error: String((error as Error).stack ?? error).slice(0, 1500) };
      }
      const released = await ctx.releaseAll();
      checks[name] = {
        measuredAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        ...result,
        unreleased: released,
      };
      writeFindings(args.out, findings);
      log('check done', name, `${Date.now() - started}ms`);
    }
  } finally {
    const failures = await ctx.releaseAll();
    const live = await api('GET', '/v1/sessions');
    const liveIds = Array.isArray(live.body)
      ? live.body.map((s) => (s as Json).session_id as string)
      : [];
    const creditsEnd = await creditsBalance();
    findings.lastRun = {
      at: new Date().toISOString(),
      checks: selected,
      sessionsCreated: ctx.created.size,
      releaseFailures: failures,
      oursStillLive: liveIds.filter((id) => ctx.created.has(id)),
      accountLiveSessionsAfter: liveIds.length,
      creditsStart,
      creditsEnd,
      creditsSpent:
        creditsStart != null && creditsEnd != null
          ? Number((creditsStart - creditsEnd).toFixed(3))
          : null,
    };
    writeFindings(args.out, findings);
    log('done', JSON.stringify(findings.lastRun));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
