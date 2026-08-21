/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Shared by the connect flow (capturing an account session) and anything else in
 * this domain that needs to drive a remote browser. Deliberately tiny: a full
 * automation library is unnecessary and would drag a heavy dependency into a
 * path that runs inside request handling.
 *
 * Accepts either a websocket URL (what Steel hands back) or an HTTP debugging
 * base like http://127.0.0.1:9222 (local Chrome), so the same code drives both
 * production and tests.
 */

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
  sameSite?: string;
}

export interface CdpCookieInput {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
  /** Chrome REJECTS a SameSite=None cookie that is not also Secure. */
  sameSite?: 'Strict' | 'Lax' | 'None';
  sourceScheme?: 'Unset' | 'NonSecure' | 'Secure';
}

/**
 * How many of the sent cookies the browser actually KEPT.
 *
 * `Network.setCookies` reports nothing per cookie and Chrome drops invalid ones
 * silently, so the only honest measure is to read the jar back and compare.
 * Without this "applied" means "sent", which is how a fully-rejected batch
 * reported success while the account chooser showed "Signed out".
 */
export function countAccepted(
  sent: CdpCookieInput[],
  present: Array<{ name: string; domain: string }>
): number {
  const key = (n: string, d: string) => `${n}|${d.replace(/^\./, '')}`;
  const have = new Set(present.map((c) => key(c.name, c.domain)));
  return sent.filter((c) => have.has(key(c.name, c.domain))).length;
}

/** The hosted success destination used by the first-party Codex app server. */
export const CODEX_HOSTED_LOGIN_SUCCESS_URL =
  'https://chatgpt.com/codex/open-app?source=login&app_brand=chatgpt';

export interface CodexCallbackFulfillment {
  responseCode: number;
  responseHeaders: Array<{ name: string; value: string }>;
  body?: string;
}

/**
 * Validate and turn a Codex loopback request into a browser-safe response.
 *
 * This runs synchronously inside the CDP Fetch.requestPaused handler, before
 * Chromium can attempt the remote VM's localhost and paint
 * ERR_CONNECTION_REFUSED. State validation happens here as well as during the
 * token exchange so an unrelated loopback request is never treated as ours.
 */
export function codexCallbackFulfillment(
  callbackUrl: string,
  expectedState: string
): CodexCallbackFulfillment | null {
  try {
    const url = new URL(callbackUrl);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== 'localhost' ||
      (url.port !== '1455' && url.port !== '1457') ||
      url.pathname !== '/auth/callback' ||
      url.searchParams.get('state') !== expectedState
    ) {
      return null;
    }
    if (url.searchParams.get('code')) {
      return {
        responseCode: 302,
        responseHeaders: [
          { name: 'Location', value: CODEX_HOSTED_LOGIN_SUCCESS_URL },
          { name: 'Cache-Control', value: 'no-store' },
        ],
      };
    }
    if (url.searchParams.get('error')) {
      const html =
        '<!doctype html><meta charset="utf-8"><title>Sign-in not completed</title>' +
        '<main style="font:16px system-ui;padding:40px">Sign-in was not completed. Return to Rose and try again.</main>';
      return {
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(html).toString('base64'),
      };
    }
    return null;
  } catch {
    return null;
  }
}

import { cookieUrlFor, normaliseCookie } from '../../providers/browserCookies';

// Re-exported for existing importers; aliased for internal callers below.
export { cookieUrlFor, normaliseCookie };
/** Back-compat alias; the canonical name is `normaliseCookie`. */
export const normaliseCookieForChrome = normaliseCookie;

import {
  seedTargetSession,
  seedVirtualPasskeys,
  type PasskeySeed,
  type PasskeyTargetMemo,
} from './cdp.passkeys';
export type { PasskeySeed };

export interface CdpClient {
  /** Present cloud-custody passkeys via a CDP virtual authenticator (see cdp.passkeys). */
  seedPasskeys(passkeys: PasskeySeed[]): Promise<number>;
  navigate(url: string): Promise<void>;
  getCookies(urls: string[]): Promise<CdpCookie[]>;
  /** Inject one cookie. Used to seed a cloud browser from the user's local session. */
  /** Batched form -- one round-trip for the whole set. */
  /** Returns how many cookies the browser actually ACCEPTED, not how many were sent. */
  setCookies(cookies: CdpCookieInput[]): Promise<number>;
  setCookie(cookie: CdpCookieInput): Promise<number>;
  evaluate<T>(expression: string): Promise<T | undefined>;
  /** Intercept the Codex loopback request before Chromium renders a network error. */
  armCodexCallback(expectedState: string): Promise<void>;
  /** Callback captured synchronously by the request interceptor, if present. */
  getCapturedCodexCallbackUrl(): string | undefined;
  /** Current URLs reported by every page target (survives failed localhost callbacks). */
  getPageUrls(): Promise<string[]>;
  /**
   * Replace a captured loopback callback with a harmless status page.
   *
   * Codex OAuth is registered to localhost, but this browser runs in the cloud,
   * so Chromium would otherwise leave the user staring at ERR_CONNECTION_REFUSED
   * while the backend exchanges the code it already captured.
   */
  showFinishingPage(callbackUrl: string): Promise<boolean>;
  /**
   * Evaluate on EVERY page target, returning the first non-empty result.
   *
   * The OAuth code can render on a target other than the one we attached to (a
   * "Continue with Google" sign-in ends up in a different window), so reading
   * only the original target misses it.
   */
  evaluateAnyTarget<T>(expression: string): Promise<T | undefined>;
  close(): void;
}

async function resolveWebSocketUrl(cdpBase: string): Promise<string> {
  if (cdpBase.startsWith('ws://') || cdpBase.startsWith('wss://')) return cdpBase;
  const targets = (await (await fetch(`${cdpBase}/json`)).json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = targets.find((t) => t.type === 'page');
  if (page === undefined) throw new Error(`no page target at ${cdpBase}`);
  return page.webSocketDebuggerUrl;
}

async function openCdpSocket(cdpBase: string): Promise<WebSocket> {
  const ws = new WebSocket(await resolveWebSocketUrl(cdpBase));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`CDP connect failed: ${cdpBase}`)), {
      once: true,
    });
  });
  return ws;
}

type CdpSend = (
  method: string,
  params?: unknown,
  opts?: { raw?: boolean; sessionId?: string }
) => Promise<Record<string, unknown>>;

/**
 * Attach to a page target so Runtime/Network have an execution context.
 *
 * A browser-level socket answers these commands with empty results instead of
 * failing, so skipping this produces a silent, very confusing no-op.
 */
async function attachToPageTarget(
  send: CdpSend
): Promise<{ sessionId?: string; targetId?: string }> {
  const targetsRes = (await send('Target.getTargets', {}, { raw: true })) as {
    result?: { targetInfos?: Array<{ targetId: string; type: string }> };
  };
  const pageTarget = targetsRes.result?.targetInfos?.find((t) => t.type === 'page');
  if (pageTarget === undefined) return {};

  const attached = (await send(
    'Target.attachToTarget',
    { targetId: pageTarget.targetId, flatten: true },
    { raw: true }
  )) as { result?: { sessionId?: string } };
  return { sessionId: attached.result?.sessionId, targetId: pageTarget.targetId };
}

async function setCookiesBatchImpl(send: CdpSend, cookies: CdpCookieInput[]): Promise<number> {
  if (cookies.length === 0) return 0;
  await send('Network.enable');
  // Cookies MUST be injected before navigating: setting them afterwards
  // leaves the page already rendered as logged-out, and the user sees a
  // login form even though the session is valid.
  await send('Network.setCookies', {
    cookies: cookies.map((raw) => {
      const c = normaliseCookieForChrome(raw);
      return {
        name: c.name,
        value: c.value,
        // ALWAYS send a url. CDP resolves host and scheme from it, and a
        // __Host- cookie carries no domain -- with neither, Chrome cannot tell
        // which host the cookie belongs to and silently drops every one.
        url: cookieUrlFor(raw),
        ...(c.domain !== '' ? { domain: c.domain } : {}),
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        ...(c.expires !== undefined ? { expires: c.expires } : {}),
        ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
        ...(c.sourceScheme !== undefined ? { sourceScheme: c.sourceScheme } : {}),
      };
    }),
  });

  const readBack = (await send('Network.getAllCookies')) as {
    result?: { cookies?: Array<{ name: string; domain: string }> };
  };
  return countAccepted(cookies, readBack.result?.cookies ?? []);
}

/**
 * Seed passkeys the INSTANT a new page target attaches.
 *
 * A "Continue with Google" popup runs navigator.credentials.get() within ~1s of
 * opening -- faster than any poll -- so a 2s re-seed loses the race. Auto-attach
 * fires on target creation, before the page runs its ceremony. Returns a handle
 * to arm/replace the passkeys to seed onto future targets.
 */
function armAutoAttachSeeding(
  ws: WebSocket,
  send: CdpSend,
  memo: PasskeyTargetMemo
): { set: (p: PasskeySeed[]) => void } {
  const armed: { passkeys: PasskeySeed[] } = { passkeys: [] };
  ws.addEventListener('message', (e: MessageEvent) => {
    let msg: {
      method?: string;
      params?: { sessionId?: string; targetInfo?: { type?: string; targetId?: string } };
    };
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.method !== 'Target.attachedToTarget') return;
    const sid = msg.params?.sessionId;
    const info = msg.params?.targetInfo;
    if (sid === undefined || info?.type !== 'page' || info.targetId === undefined) return;
    if (armed.passkeys.length === 0 || memo.has(info.targetId)) return;
    memo.add(info.targetId);
    void seedTargetSession(send, sid, armed.passkeys)
      .then((seeded) => {
        if (!seeded) memo.delete(info.targetId as string);
      })
      .catch(() => memo.delete(info.targetId as string));
  });
  return { set: (p) => (armed.passkeys = p) };
}

/** Evaluate on every page target; first non-empty value wins. */
async function evaluateOnAllTargets<T>(send: CdpSend, expression: string): Promise<T | undefined> {
  const targetsRes = (await send('Target.getTargets', {}, { raw: true })) as {
    result?: { targetInfos?: Array<{ targetId: string; type: string }> };
  };
  const pages = (targetsRes.result?.targetInfos ?? []).filter((t) => t.type === 'page');
  for (const target of pages) {
    const attached = (await send(
      'Target.attachToTarget',
      { targetId: target.targetId, flatten: true },
      { raw: true }
    )) as { result?: { sessionId?: string } };
    const sessionId = attached.result?.sessionId;
    if (sessionId === undefined) continue;
    const out = (await send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      { sessionId }
    )) as {
      result?: { result?: { value?: T | null } };
    };
    const value = out.result?.result?.value ?? undefined;
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export async function attachCdp(cdpBase: string): Promise<CdpClient> {
  const ws = await openCdpSocket(cdpBase);

  let seq = 0;
  // Remote providers (Kernel, Steel) hand back a BROWSER-level websocket, not a
  // page one. Browser-level connections have no execution context, so
  // Runtime/Network commands silently return nothing -- which presents as
  // "0 cookies, no URL" rather than an error. Everything must therefore be sent
  // against an attached page target's sessionId.
  // Boxed: `send` closes over it, yet `send` is what discovers it.
  const page: { sessionId: string | undefined; targetId: string | undefined } = {
    sessionId: undefined,
    targetId: undefined,
  };
  const send = (
    method: string,
    params: unknown = {},
    opts: { raw?: boolean; sessionId?: string } = {}
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const id = (seq += 1);
      const handler = (e: MessageEvent) => {
        const msg = JSON.parse(String(e.data)) as { id?: number };
        if (msg.id === id) {
          ws.removeEventListener('message', handler);
          resolve(msg as Record<string, unknown>);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(opts.sessionId !== undefined
            ? { sessionId: opts.sessionId }
            : opts.raw !== true && page.sessionId !== undefined
              ? { sessionId: page.sessionId }
              : {}),
        })
      );
    });

  const codexCallback: { expectedState: string | null; capturedUrl?: string } = {
    expectedState: null,
  };
  const codexPatterns = [
    { urlPattern: 'http://localhost:1455/auth/callback*', requestStage: 'Request' },
    { urlPattern: 'http://localhost:1457/auth/callback*', requestStage: 'Request' },
  ];
  ws.addEventListener('message', (event: MessageEvent) => {
    let message: {
      method?: string;
      sessionId?: string;
      params?: {
        requestId?: string;
        request?: { url?: string };
        sessionId?: string;
        targetInfo?: { type?: string };
      };
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    // SSO can finish in a different page target. Auto-attach gives us its CDP
    // session early enough to install the same interception there.
    if (
      message.method === 'Target.attachedToTarget' &&
      codexCallback.expectedState !== null &&
      message.params?.targetInfo?.type === 'page' &&
      message.params.sessionId !== undefined
    ) {
      void send(
        'Fetch.enable',
        { patterns: codexPatterns },
        { sessionId: message.params.sessionId }
      );
      return;
    }

    if (message.method !== 'Fetch.requestPaused') return;
    const requestId = message.params?.requestId;
    const callbackUrl = message.params?.request?.url;
    const expectedState = codexCallback.expectedState;
    if (requestId === undefined || callbackUrl === undefined || expectedState === null) return;
    const fulfillment = codexCallbackFulfillment(callbackUrl, expectedState);
    const session = message.sessionId !== undefined ? { sessionId: message.sessionId } : {};
    if (fulfillment === null) {
      void send('Fetch.continueRequest', { requestId }, session);
      return;
    }
    codexCallback.capturedUrl ??= callbackUrl;
    void send('Fetch.fulfillRequest', { requestId, ...fulfillment }, session);
  });

  const attachedPage = await attachToPageTarget(send);
  page.sessionId = attachedPage.sessionId;
  page.targetId = attachedPage.targetId;

  const setCookiesBatch = (cookies: CdpCookieInput[]) => setCookiesBatchImpl(send, cookies);
  const passkeyMemo: PasskeyTargetMemo = new Set();

  const armed = armAutoAttachSeeding(ws, send, passkeyMemo);

  return {
    async navigate(url: string) {
      await send('Page.enable');
      await send('Page.navigate', { url });
      // The consent/login screens are SPAs; give the first paint a moment so
      // callers polling for cookies or text aren't racing an empty document.
      await new Promise((r) => setTimeout(r, 3_000));
    },

    /**
     * Set every cookie in ONE round-trip.
     *
     * `Network.setCookie` per cookie meant 2 round-trips each (enable + set) to
     * a REMOTE browser -- ~28 sequential calls for a typical session, which is
     * why the login page took ten-plus seconds to appear. `Network.setCookies`
     * accepts the whole array, so seeding is now two calls total regardless of
     * how many cookies the user has.
     */
    setCookie: async (cookie: CdpCookieInput) => setCookiesBatch([cookie]),
    setCookies: setCookiesBatch,
    async getCookies(urls: string[]) {
      await send('Network.enable');
      const out = (await send('Network.getCookies', { urls })) as {
        result?: { cookies?: CdpCookie[] };
      };
      return out.result?.cookies ?? [];
    },
    async evaluate<T>(expression: string): Promise<T | undefined> {
      const out = (await send('Runtime.evaluate', { expression, returnByValue: true })) as {
        result?: { result?: { value?: T | null } };
      };
      // CDP reports a JS null literally; normalise so `=== undefined` guards work.
      return out.result?.result?.value ?? undefined;
    },
    async armCodexCallback(expectedState: string): Promise<void> {
      codexCallback.expectedState = expectedState;
      await send('Fetch.enable', { patterns: codexPatterns });
      // Also receive any top-level page opened by an SSO handoff. The passkey
      // path enables the same setting, but callback interception must work even
      // when this user has no passkeys saved.
      await send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        { raw: true }
      );
    },
    getCapturedCodexCallbackUrl(): string | undefined {
      return codexCallback.capturedUrl;
    },
    async getPageUrls(): Promise<string[]> {
      const targetsRes = (await send('Target.getTargets', {}, { raw: true })) as {
        result?: { targetInfos?: Array<{ type: string; url?: string }> };
      };
      return (targetsRes.result?.targetInfos ?? [])
        .filter((target) => target.type === 'page' && typeof target.url === 'string')
        .map((target) => target.url as string);
    },
    async showFinishingPage(callbackUrl: string): Promise<boolean> {
      const callback = new URL(callbackUrl);
      if (
        callback.protocol !== 'http:' ||
        callback.hostname !== 'localhost' ||
        (callback.port !== '1455' && callback.port !== '1457') ||
        callback.pathname !== '/auth/callback'
      ) {
        return false;
      }

      const targetsRes = (await send('Target.getTargets', {}, { raw: true })) as {
        result?: {
          targetInfos?: Array<{ targetId: string; type: string; url?: string }>;
        };
      };
      const target = (targetsRes.result?.targetInfos ?? []).find(
        (candidate) => candidate.type === 'page' && candidate.url === callbackUrl
      );
      if (target === undefined) return false;

      const attached = (await send(
        'Target.attachToTarget',
        { targetId: target.targetId, flatten: true },
        { raw: true }
      )) as { result?: { sessionId?: string } };
      const sessionId = attached.result?.sessionId;
      if (sessionId === undefined) return false;

      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Finishing connection</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #fff; color: #171717; }
      main { display: flex; align-items: center; gap: 14px; padding: 24px; }
      .spinner { width: 20px; height: 20px; border: 2px solid #d4d4d4; border-top-color: #537fff; border-radius: 50%; animation: spin .8s linear infinite; }
      h1 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
      p { margin: 0; color: #737373; font-size: 13px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #fafafa; } p { color: #a3a3a3; } }
    </style>
  </head>
  <body><main><div class="spinner"></div><div><h1>Finishing connection</h1><p>You can keep this window open.</p></div></main></body>
</html>`;
      await send(
        'Page.navigate',
        { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` },
        { sessionId }
      );
      return true;
    },
    evaluateAnyTarget: <T>(expression: string) => evaluateOnAllTargets<T>(send, expression),
    async seedPasskeys(passkeys: PasskeySeed[]): Promise<number> {
      // Seed current pages synchronously first. Enabling auto-attach can emit an
      // immediate attached event for those same pages; doing it first made the
      // handler reserve the target while seeding in the background, so this
      // method returned 0 before any credential was actually present.
      armed.set(passkeys);
      let existing = 0;
      if (
        passkeys.length > 0 &&
        page.sessionId !== undefined &&
        page.targetId !== undefined &&
        !passkeyMemo.has(page.targetId)
      ) {
        if (await seedTargetSession(send, page.sessionId, passkeys)) {
          passkeyMemo.add(page.targetId);
          existing += 1;
        }
      }
      existing += await seedVirtualPasskeys(send, passkeys, passkeyMemo);
      if (passkeys.length > 0) {
        // Browser-level (raw): catches future TOP-LEVEL popup windows too, not
        // just children of the current page. Google's sign-in can be either.
        await send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          { raw: true }
        );
      }
      return existing;
    },
    close: () => ws.close(),
  };
}
