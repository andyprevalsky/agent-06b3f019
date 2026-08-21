/**
 * Cloud-only Claude grant re-mint.
 *
 * Mints a fresh `setup-token` grant from nothing but a stored claude.ai session,
 * in a headless browser, with no user present and no dependency on anyone's
 * laptop. This is the recovery path behind a dead compute token: the rose
 * completion path reports 401/403-revoked, and this mints a replacement.
 *
 * PROVEN END-TO-END 2026-08-18 from a COLD profile (no prior login), cookies
 * injected only:
 *   cold profile + 17 cookies -> Cloudflare passed -> consent rendered ->
 *   authorized headlessly -> expires_in=31536000 (365d), scope="user:inference"
 *   -> real inference HTTP 200 -> "CLOUDMINT"
 *
 * CDP-endpoint agnostic on purpose: point it at a local headless Chrome for
 * tests, or at a Steel/Kernel session in production. Steel already does remote
 * browsers with cookie injection, so this needs no new infrastructure -- and E2B
 * is the wrong tool (it is a code sandbox, not a browser).
 *
 *   CDP_URL=http://127.0.0.1:9335 npx tsx scripts/claude-cloud-remint.ts
 *
 * ---------------------------------------------------------------------------
 * FOUR MECHANICS THAT ARE NOT OPTIONAL. Each cost a debugging cycle; each looks
 * like "it just doesn't work" when missing.
 *
 * 1. STEALTH FLAGS OR CLOUDFLARE EATS YOU. Vanilla `--headless=new` is served
 *    "Performing security verification" forever and the consent screen NEVER
 *    renders. Launch with `--disable-blink-features=AutomationControlled` (drives
 *    navigator.webdriver to false) plus a real desktop User-Agent. With those,
 *    the consent screen renders in ~5s.
 *
 * 2. REAL MOUSE EVENTS, NOT element.click(). React's consent button ignores
 *    synthetic .click() -- it reports success and the handler never fires.
 *    Requires a hover first, then a press carrying the `buttons: 1` mask:
 *      mouseMoved(buttons:0) -> mousePressed(button:left, buttons:1) -> mouseReleased
 *    with small delays between. Also `scrollIntoView` first: the button sits below
 *    the fold and CDP coordinates are viewport-relative.
 *
 * 3. THE FIRST CLICK OFTEN DOESN'T TAKE. Even with correct events, attempt 1
 *    frequently lands before React has attached handlers, and the page simply does
 *    not navigate. Retry the whole click. Observed needing attempt 2 on a cold
 *    profile. A single-shot click is why this "worked locally, failed in cloud".
 *
 * 4. USE THE MANUAL REDIRECT, AND DON'T MATCH `code=true`. A localhost callback is
 *    the BROWSER's loopback, not the backend's -- in a remote browser the code
 *    never arrives. Use MANUAL_REDIRECT_URL and scrape the code off the callback
 *    URL. Critically, the authorize request itself contains `code=true`, so a naive
 *    /[?&]code=/ match silently captures the literal string "true" and the exchange
 *    fails with a confusing `invalid_grant`. Gate on the callback host AND reject
 *    "true".
 * ---------------------------------------------------------------------------
 */

import { createHash, randomBytes } from 'node:crypto';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Manual redirect: renders the code in-page, so no inbound networking is needed. */
const MANUAL_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback';
const SCOPE = 'user:inference';
const SETUP_TOKEN_EXPIRES_IN = 31_536_000;
const UA = 'claude-cli/2.1.88 (external, cli)';

/** Flags a cloud browser MUST launch with. See mechanic (1). */
export const REQUIRED_CHROME_FLAGS = [
  '--disable-blink-features=AutomationControlled',
  '--window-size=1512,982',
  '--lang=en-US',
  '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
];

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

interface Cdp {
  send(method: string, params?: unknown): Promise<Record<string, unknown>>;
  evaluate<T>(expression: string): Promise<T | undefined>;
  close(): void;
}

/**
 * Resolve a CDP endpoint to a page WebSocket.
 *
 * Accepts either form, because the two environments hand out different things:
 * a local Chrome exposes an HTTP debugging port to enumerate targets, while
 * Steel hands back a ready `ws://`/`wss://` URL with no HTTP surface to query.
 * Requiring one shape would have meant this worked locally and failed in cloud.
 */
async function resolvePageSocket(cdpBase: string): Promise<string> {
  if (cdpBase.startsWith('ws://') || cdpBase.startsWith('wss://')) return cdpBase;
  const targets = (await (await fetch(`${cdpBase}/json`)).json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = targets.find((t) => t.type === 'page');
  if (page === undefined) throw new Error(`no page target at ${cdpBase}`);
  return page.webSocketDebuggerUrl;
}

async function attach(cdpBase: string): Promise<Cdp> {
  const ws = new WebSocket(await resolvePageSocket(cdpBase));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP connect failed')), { once: true });
  });
  let seq = 0;
  // Remote providers (Kernel, Steel) expose a BROWSER-level websocket, while a
  // locally launched Chrome exposes a page one. A browser-level socket answers
  // Runtime/Network commands with EMPTY RESULTS rather than an error, so without
  // attaching to a page target this fails as "consent screen never rendered" and
  // looks exactly like a bot block. Everything is therefore sent against an
  // attached page session when one exists.
  let pageSessionId: string | undefined;
  const send = (
    method: string,
    params: unknown = {},
    opts: { raw?: boolean } = {}
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
          ...(opts.raw !== true && pageSessionId !== undefined ? { sessionId: pageSessionId } : {}),
        })
      );
    });
  const targets = (await send('Target.getTargets', {}, { raw: true })) as {
    result?: { targetInfos?: Array<{ targetId: string; type: string }> };
  };
  const page = targets.result?.targetInfos?.find((t) => t.type === 'page');
  if (page !== undefined) {
    const attached = (await send(
      'Target.attachToTarget',
      { targetId: page.targetId, flatten: true },
      { raw: true }
    )) as { result?: { sessionId?: string } };
    pageSessionId = attached.result?.sessionId;
  }

  return {
    send,
    async evaluate<T>(expression: string): Promise<T | undefined> {
      const out = (await send('Runtime.evaluate', { expression, returnByValue: true })) as {
        result?: { result?: { value?: T | null } };
      };
      // CDP reports a JS `null` as a literal null, so normalise it to undefined --
      // otherwise `=== undefined` poll guards never trip and the caller receives a
      // null it did not expect (this exact gap threw "Cannot read ... of null").
      return out.result?.result?.value ?? undefined;
    },
    close: () => ws.close(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64url = (b: Buffer) => b.toString('base64url');

const FIND_AUTHORIZE = `(function(){
  var b = Array.prototype.slice.call(document.querySelectorAll('button'))
    .filter(function(e){ return /^authorize$/i.test((e.innerText||'').trim()) })[0];
  if (!b) return null;
  b.scrollIntoView({block:'center'});          // mechanic (2): below the fold
  var r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
})()`;

/** mechanic (4): gate on the callback host and reject the literal "true". */
export const READ_CODE = `(function(){
  // The authorize request itself carries \`code=true\`, so a naive /code=/ match
  // captures the literal string "true" and the exchange fails with a confusing
  // invalid_grant. Only accept a code from the CALLBACK, and never "true".
  var m = location.href.match(/[?&]code=([^&#]+)/);
  if (/oauth\\/code\\/callback/.test(location.href) && m && m[1] !== 'true') {
    return decodeURIComponent(m[1]);
  }
  // The callback page also RENDERS the code for manual copying, which survives
  // even when the URL has been rewritten by the SPA.
  var el = document.querySelector('input[value], code, pre');
  var v = el ? (el.value || el.textContent || '').trim() : '';
  if (/^[A-Za-z0-9_-]{20,}(#[A-Za-z0-9_-]+)?$/.test(v)) return v;
  var t = (document.body ? document.body.innerText : '').match(/[A-Za-z0-9_-]{24,}#[A-Za-z0-9_-]{6,}/);
  return t ? t[0] : null;
})()`;

export interface RemintResult {
  accessToken: string;
  expiresIn: number;
  scope: string;
  clickAttempts: number;
  /**
   * Account identity, taken from the token-exchange response.
   *
   * NOT fetched from /api/oauth/profile: a setup-token is minted
   * `inferenceOnly`, so it lacks `user:profile` and that endpoint rejects it.
   * The exchange response carries `account` regardless, which is what keeps two
   * connected accounts distinguishable.
   */
  accountId?: string;
  accountEmail?: string;
}

/**
 * Mint a fresh grant using only the supplied session cookies.
 *
 * Deliberately takes no existing token: a dead grant must never block recovery,
 * so minting depends solely on the account connection.
 */
/**
 * Build the OAuth authorize URL and its PKCE verifier.
 *
 * Exposed so the connect flow can navigate STRAIGHT here instead of loading
 * claude.ai/login first. Cookie injection happens over CDP before any
 * navigation and applies per-domain, so the login hop bought nothing: with a
 * valid session the consent screen renders immediately, and without one
 * claude.ai redirects to login and returns here automatically after sign-in.
 */
export function buildAuthorizeUrl(): { url: string; verifier: string; state: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(24));
  const url =
    `${AUTHORIZE_URL}?code=true&client_id=${CLIENT_ID}&response_type=code` +
    `&redirect_uri=${encodeURIComponent(MANUAL_REDIRECT_URL)}&scope=${encodeURIComponent(SCOPE)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
  return { url, verifier, state };
}

/** JS that reports whether the consent screen (or a login form) is interactive. */
export const AUTHORIZE_PAGE_READY = `(function(){
  var b = Array.prototype.slice.call(document.querySelectorAll('button'))
    .filter(function(e){ return /^(authorize|continue with|sign in|log in)/i.test((e.innerText||'').trim()) });
  if (b.length) return true;
  return document.querySelectorAll('input[type=email],input[type=password]').length > 0;
})()`;

/**
 * Exchange an authorization code that the USER produced by clicking Authorize.
 *
 * Split out because the connect flow now navigates straight to the consent
 * screen with its OWN PKCE pair. Re-running cloudRemint at that point would
 * generate a fresh verifier and re-navigate, invalidating the code already
 * sitting on screen -- which is exactly how the code was left uncaptured while
 * the page displayed it.
 */
export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  fallbackState: string
): Promise<RemintResult> {
  const [rawCode, embeddedState] = code.split('#');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: rawCode,
      redirect_uri: MANUAL_REDIRECT_URL,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state: embeddedState ?? fallbackState,
      expires_in: SETUP_TOKEN_EXPIRES_IN,
    }),
  });
  if (!res.ok)
    throw new Error(`exchange failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    access_token: string;
    expires_in: number;
    scope: string;
    account?: { uuid?: string; email_address?: string };
  };
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    scope: body.scope,
    clickAttempts: 0,
    accountId: body.account?.uuid,
    accountEmail: body.account?.email_address,
  };
}

export interface CloudRemintOptions {
  /**
   * Click Authorize on the user's behalf.
   *
   * Only for the UNATTENDED path. When a human is watching the live view they
   * must click it themselves: the consent screen routinely serves a bot-check
   * (observed: "Drag the shape into its outline") that an auto-clicker cannot
   * solve but a person can, and racing the user for the button just makes the
   * failure harder to understand.
   */
  autoClick?: boolean;
  /** How long to wait for the code before giving up. Humans need longer. */
  codeTimeoutMs?: number;
}

export async function cloudRemint(
  cdpBase: string,
  cookies: CdpCookie[],
  options: CloudRemintOptions = {}
): Promise<RemintResult> {
  const autoClick = options.autoClick ?? true;
  const cdp = await attach(cdpBase);
  try {
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    for (const c of cookies) {
      await cdp.send('Network.setCookie', {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expires: c.expires !== undefined && c.expires > 0 ? c.expires : undefined,
        sameSite: c.sameSite,
      });
    }

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(24));
    await cdp.send('Page.navigate', {
      url:
        `${AUTHORIZE_URL}?code=true&client_id=${CLIENT_ID}&response_type=code` +
        `&redirect_uri=${encodeURIComponent(MANUAL_REDIRECT_URL)}&scope=${encodeURIComponent(SCOPE)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`,
    });

    let button: { x: number; y: number } | undefined;
    for (let i = 0; i < 25 && button === undefined; i += 1) {
      await sleep(1500);
      button = await cdp.evaluate<{ x: number; y: number }>(FIND_AUTHORIZE);
    }
    if (button === undefined) {
      const seen = await cdp.evaluate<string>('document.body.innerText.slice(0,160)');
      throw new Error(
        `consent screen never rendered (bot-check?). Page said: ${seen ?? '(nothing)'}. ` +
          'Confirm the browser launched with REQUIRED_CHROME_FLAGS.'
      );
    }

    // mechanic (3): the first click frequently lands before React is ready.
    let code: string | undefined;
    let clickAttempts = 0;
    const deadline = Date.now() + (options.codeTimeoutMs ?? (autoClick ? 60_000 : 300_000));
    if (autoClick) {
      for (let attempt = 1; attempt <= 3 && code === undefined; attempt += 1) {
        const target = (await cdp.evaluate<{ x: number; y: number }>(FIND_AUTHORIZE)) ?? button;
        clickAttempts = attempt;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...target, buttons: 0 });
        await sleep(150);
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...target,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await sleep(90);
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...target,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        for (let i = 0; i < 25 && code === undefined; i += 1) {
          await sleep(1500);
          code = await cdp.evaluate<string>(READ_CODE);
        }
      }
    } else {
      // The human clicks Authorize in the live view; we only watch for the code.
      while (code === undefined && Date.now() < deadline) {
        await sleep(1500);
        code = await cdp.evaluate<string>(READ_CODE);
      }
    }

    if (code === undefined) {
      // Report what the page actually looked like: a silent click failure is
      // otherwise indistinguishable from a bot block.
      const diag = await cdp.evaluate<string>(
        `JSON.stringify({url:location.href.slice(0,80),vw:innerWidth,vh:innerHeight,btn:(function(){var b=Array.prototype.slice.call(document.querySelectorAll("button")).filter(function(e){return /^authorize$/i.test((e.innerText||"").trim())})[0];if(!b)return null;var r=b.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),vis:b.offsetParent!==null};})()})`
      );
      throw new Error(`authorize click produced no code; diag=${diag ?? 'none'}`);
    }

    const [rawCode, embeddedState] = code.split('#');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: rawCode,
        redirect_uri: MANUAL_REDIRECT_URL,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        state: embeddedState ?? state,
        expires_in: SETUP_TOKEN_EXPIRES_IN,
      }),
    });
    if (!res.ok)
      throw new Error(`exchange failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      access_token: string;
      expires_in: number;
      scope: string;
      account?: { uuid?: string; email_address?: string };
    };
    return {
      accessToken: body.access_token,
      expiresIn: body.expires_in,
      scope: body.scope,
      clickAttempts,
      accountId: body.account?.uuid,
      accountEmail: body.account?.email_address,
    };
  } finally {
    cdp.close();
  }
}

/** Verify a grant by doing real inference -- assert on content, not status. */
export async function verifyGrant(accessToken: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': UA,
      authorization: `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 10,
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: 'user', content: 'reply with the single word CLOUDMINT' }],
    }),
  });
  const text = await res.text();
  return { ok: res.status === 200 && /CLOUDMINT/.test(text), detail: `HTTP ${res.status}` };
}
