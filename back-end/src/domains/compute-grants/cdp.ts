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

import { createCodexCallbackController } from './cdp.codex';
export {
  CODEX_HOSTED_LOGIN_SUCCESS_URL,
  codexCallbackFulfillment,
  type CodexCallbackFulfillment,
} from './cdp.codex';

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

import { cookieUrlFor, normaliseCookie } from '../../providers/browserCookies';

// Re-exported for existing importers; aliased for internal callers below.
export { cookieUrlFor, normaliseCookie };
/** Back-compat alias; the canonical name is `normaliseCookie`. */
export const normaliseCookieForChrome = normaliseCookie;

import { createConnectPasskeys, type PasskeySeed } from './cdp.passkeys';
export type { PasskeySeed };

export interface CdpClient {
  /** Present cloud-custody passkeys via a CDP virtual authenticator (see cdp.passkeys). */
  seedPasskeys(passkeys: PasskeySeed[]): Promise<number>;
  /**
   * Read the main page's unanswered-passkey record (see cdp.passkeyCeremonies);
   * resolves to the relying party the seeded authenticator could not answer.
   */
  syncPasskeyCeremonies(): Promise<string | undefined>;
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

function createCdpSend(ws: WebSocket, page: { sessionId: string | undefined }): CdpSend {
  let seq = 0;
  return (method, params = {}, opts = {}) =>
    new Promise((resolve) => {
      const id = (seq += 1);
      const handler = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as { id?: number };
        if (message.id !== id) return;
        ws.removeEventListener('message', handler);
        resolve(message as Record<string, unknown>);
      };
      ws.addEventListener('message', handler);
      const sessionId = opts.sessionId ?? (opts.raw !== true ? page.sessionId : undefined);
      ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId !== undefined ? { sessionId } : {}),
        })
      );
    });
}

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

/** Evaluate on the attached page's session. */
async function evaluateOnPage<T>(send: CdpSend, expression: string): Promise<T | undefined> {
  const out = (await send('Runtime.evaluate', { expression, returnByValue: true })) as {
    result?: { result?: { value?: T | null } };
  };
  // CDP reports a JS null literally; normalise so `=== undefined` guards work.
  return out.result?.result?.value ?? undefined;
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
  const send = createCdpSend(ws, page);
  const codexCallback = createCodexCallbackController(ws, send);

  const attachedPage = await attachToPageTarget(send);
  page.sessionId = attachedPage.sessionId;
  page.targetId = attachedPage.targetId;

  const setCookiesBatch = (cookies: CdpCookieInput[]) => setCookiesBatchImpl(send, cookies);
  const passkeys = createConnectPasskeys(ws, send, page, (expression) =>
    evaluateOnPage<string>(send, expression)
  );

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
    evaluate: <T>(expression: string) => evaluateOnPage<T>(send, expression),
    async armCodexCallback(expectedState: string): Promise<void> {
      await codexCallback.arm(expectedState);
    },
    getCapturedCodexCallbackUrl(): string | undefined {
      return codexCallback.getCapturedUrl();
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
      return codexCallback.showFinishingPage(callbackUrl);
    },
    evaluateAnyTarget: <T>(expression: string) => evaluateOnAllTargets<T>(send, expression),
    seedPasskeys: (seeds: PasskeySeed[]) => passkeys.seed(seeds),
    syncPasskeyCeremonies: () => passkeys.syncCeremonies(),
    close: () => ws.close(),
  };
}
