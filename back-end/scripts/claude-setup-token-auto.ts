#!/usr/bin/env tsx
/**
 * Fully-automated `claude setup-token` equivalent + grant-independence probe.
 *
 * WHY NOT JUST SHELL OUT TO `claude setup-token`?
 * -----------------------------------------------
 * The CLI renders an Ink TUI: with stdout piped it emits nothing (so the
 * authorization URL is invisible), and it expects a human to click "Authorize"
 * in a browser. This script performs the same OAuth flow directly -- same
 * client_id, same PKCE, same `expires_in` -- while driving Chrome to click the
 * button, so the whole thing runs unattended.
 *
 * ONE-TIME PREREQUISITE (macOS blocks this otherwise, and it cannot be
 * self-granted): in Chrome, enable
 *     View > Developer > Allow JavaScript from Apple Events
 * Without it Chrome refuses `execute javascript` and this script will tell you so
 * rather than silently hanging.
 *
 * WHAT IT PROVES
 * --------------
 * Mints an independent inference-only grant, then checks whether that new
 * authorization revoked either (a) a previously minted grant, or (b) the
 * interactive /login session token. That is the load-bearing assumption behind
 * holding a Claude token in the cloud: if a new auth evicts old ones, a
 * cloud-held token dies whenever the user logs in anywhere.
 *
 *   npx tsx scripts/claude-setup-token-auto.ts           # mint 2, prove independence
 *   npx tsx scripts/claude-setup-token-auto.ts --mint    # just mint 1 and print it
 *
 * NEVER writes the keychain, so the active login is untouched.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const SCOPE = 'user:inference';
/** What the official client requests for setup-token. The server may cap it. */
const SETUP_TOKEN_EXPIRES_IN = 31_536_000;
const UA = 'claude-cli/2.1.88 (external, cli)';
const LEDGER = join(dirname(new URL(import.meta.url).pathname), '.claude-grant-independence.jsonl');

const b64url = (b: Buffer) => b.toString('base64url');

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/**
 * Chrome DevTools Protocol driver.
 *
 * Preferred over AppleScript because it needs NO macOS permission grants: Chrome
 * refuses remote debugging on the DEFAULT profile ("requires a non-default data
 * directory"), but is happy on a dedicated one. That dedicated profile is also
 * where the burner test account should live, so conformance runs can never
 * collide with the account the developer's own Claude Code session depends on.
 *
 *   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *     --remote-debugging-port=9222 --user-data-dir=<persistent-dir> --no-first-run
 */
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);

interface CdpSession {
  eval<T>(expression: string): Promise<T | undefined>;
  navigate(url: string): Promise<void>;
  clickByText(pattern: string): Promise<boolean>;
  close(): void;
}

async function cdpConnect(): Promise<CdpSession | null> {
  let pages: Array<{ type: string; webSocketDebuggerUrl: string }>;
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, {
      signal: AbortSignal.timeout(2000),
    });
    pages = (await res.json()) as typeof pages;
  } catch {
    return null;
  }
  const page = pages.find((p) => p.type === 'page');
  if (page === undefined) return null;

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  let seq = 0;
  const send = (method: string, params: unknown): Promise<Record<string, unknown>> =>
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
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    async eval<T>(expression: string): Promise<T | undefined> {
      const out = (await send('Runtime.evaluate', { expression, returnByValue: true })) as {
        result?: { result?: { value?: T } };
      };
      return out.result?.result?.value;
    },
    async navigate(url: string): Promise<void> {
      await send('Page.navigate', { url });
    },
    /**
     * Click by dispatching a REAL mouse event at the element's centre.
     *
     * `element.click()` from Runtime.evaluate is not enough: claude.ai's consent
     * screen is React, and the synthetic call reports success while the handler
     * never fires. Scrolling into view first matters too -- the button sits below
     * the fold at common window sizes, and CDP coordinates are viewport-relative,
     * so an unscrolled click lands on empty space.
     */
    async clickByText(pattern: string): Promise<boolean> {
      const raw = await (async () => {
        const out = (await send('Runtime.evaluate', {
          expression: `(function(){
            var b=Array.from(document.querySelectorAll('button,a,[role=button]'))
              .find(e=>${pattern}.test((e.innerText||e.textContent||'').trim()));
            if(!b) return null;
            b.scrollIntoView({block:'center'});
            var r=b.getBoundingClientRect();
            return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});
          })()`,
          returnByValue: true,
        })) as { result?: { result?: { value?: string | null } } };
        return out.result?.result?.value ?? null;
      })();
      if (raw === null) return false;
      const { x, y } = JSON.parse(raw) as { x: number; y: number };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      return true;
    },
    close: () => ws.close(),
  };
}

function osa(script: string): string {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
}

function chromeJs(js: string): string {
  // Chrome requires the JS payload as an AppleScript string literal.
  const escaped = js.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return osa(
    `tell application "Google Chrome" to return execute front window's active tab javascript "${escaped}"`
  );
}

/**
 * Can we click for the user, or must the consent screen auto-approve?
 *
 * Not fatal when unavailable: claude.ai may skip the consent screen entirely for a
 * client the account has already authorized (which is the case for claude-code on
 * any machine that has logged in), in which case the authorize URL redirects
 * straight to our callback and no click is needed at all.
 */
function chromeCanClick(): boolean {
  try {
    chromeJs('1+1');
    return true;
  } catch {
    return false;
  }
}

/** Wait for the OAuth redirect to hit our loopback listener. */
function awaitCallback(server: Server, expectedState: string): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for OAuth callback')),
      180_000
    );
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h3>Authorized. You can close this tab.</h3></body></html>');
      if (code === null) return;
      clearTimeout(timer);
      if (state !== expectedState) {
        reject(new Error('OAuth state mismatch -- possible interference, aborting'));
        return;
      }
      resolve({ code });
    });
  });
}

async function exchange(
  code: string,
  verifier: string,
  redirectUri: string,
  state: string
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      // Field set and order mirror the official client's exchange (cli.js). `state`
      // is REQUIRED -- omitting it returns a bare 400 "Invalid request format"
      // that gives no hint which field is missing.
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state,
      expires_in: SETUP_TOKEN_EXPIRES_IN,
    }),
  });
  if (!res.ok)
    throw new Error(`token exchange failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  if (body.expires_in !== undefined && body.expires_in !== SETUP_TOKEN_EXPIRES_IN) {
    // The 1-year figure is what the CLIENT asks for; record what we actually got.
    console.log(
      `  note: server granted expires_in=${body.expires_in}s (requested ${SETUP_TOKEN_EXPIRES_IN}s)`
    );
  }
  return body.access_token;
}

/** Run one full authorize -> click -> exchange cycle. */
async function mint(label: string): Promise<string> {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(24));
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://localhost:${port}/callback`;

  const url =
    `${AUTHORIZE_URL}?code=true&client_id=${CLIENT_ID}&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;

  console.log(`\n  [${label}] opening authorization page...`);
  const cdp = await cdpConnect();
  if (cdp !== null) {
    await cdp.navigate(url);
  } else {
    osa(
      `tell application "Google Chrome"\n activate\n tell front window to make new tab with properties {URL:"${url}"}\nend tell`
    );
  }

  const pending = awaitCallback(server, state);

  // Poll for the Authorize button and click it. The page is a SPA, so it may not
  // be present on first paint; and once authorization completes the tab
  // navigates away, which is what ends the loop.
  const clicker = `(function(){
    var els = Array.prototype.slice.call(document.querySelectorAll('button, a, [role=button]'));
    var t = els.filter(function(e){
      var s = (e.innerText||e.textContent||'').trim();
      return /^(authorize|allow|approve|continue)$/i.test(s);
    });
    if (t.length) { t[0].click(); return 'clicked:' + (t[0].innerText||'').trim(); }
    return 'not-found';
  })()`;

  const canClick = cdp !== null || chromeCanClick();
  if (cdp !== null) {
    console.log(`  [${label}] driving via CDP on port ${CDP_PORT}`);
  } else if (!canClick) {
    console.log(
      `  [${label}] Chrome JS unavailable -- relying on auto-approval for an\n` +
        '        already-authorized client. If a consent screen appears, either click\n' +
        '        Authorize once, or enable:\n' +
        '        Chrome > View > Developer > Allow JavaScript from Apple Events'
    );
  }

  let settled = false;
  void pending.then(() => {
    settled = true;
  });

  if (canClick) {
    // Keep clicking until the callback actually lands. A single click is not
    // enough: the SPA may still be hydrating, so an early click silently no-ops.
    // The loop ends on `settled`, i.e. the redirect really happened -- never on
    // "we think we clicked something".
    let announced = false;
    for (let i = 0; i < 45 && !settled; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const hit =
          cdp !== null
            ? await cdp.clickByText('/^(authorize|allow|approve)$/i')
            : chromeJs(clicker).startsWith('clicked:');
        if (hit && !announced) {
          console.log(`  [${label}] clicked Authorize`);
          announced = true;
        }
      } catch {
        // Tab navigated / not ready; keep polling.
      }
    }
  }

  const { code } = await pending;
  cdp?.close();
  server.close();
  const token = await exchange(code, verifier, redirectUri, state);
  console.log(`  [${label}] minted (${token.slice(0, 18)}...)`);
  return token;
}

/**
 * Liveness has THREE states, not two.
 *
 * An earlier version returned `status !== 401`, which is wrong in both directions:
 * Claude Code's own client documents that some endpoints signal revocation as a
 * **403 with an "OAuth token has been revoked" body** rather than a 401
 * (`also403Revoked` in src/utils/http.ts), so a revoked token would have been
 * reported ALIVE. And a 429/500 says nothing about the credential either way --
 * silently counting that as ALIVE would let a green run mean nothing.
 *
 * So: only a real 200 carrying real content proves life; 401 and 403-revoked prove
 * death; everything else is INDETERMINATE and must be surfaced, never passed.
 */
type Liveness = 'alive' | 'dead' | 'indeterminate';

async function probeLiveness(accessToken: string): Promise<{ state: Liveness; detail: string }> {
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
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
        max_tokens: 16,
        system: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
        ],
        // A verifiable fixture: we assert on the echoed sentinel so a 200 with an
        // empty/refused body cannot masquerade as a working credential.
        messages: [{ role: 'user', content: 'Reply with exactly: GRANT_LIVE_OK' }],
      }),
    });
  } catch (err) {
    return { state: 'indeterminate', detail: `network error: ${String(err).slice(0, 80)}` };
  }

  const text = await res.text();
  if (res.status === 401) return { state: 'dead', detail: 'HTTP 401 (unauthorized/revoked)' };
  if (res.status === 403 && /revoked|invalid[_ ]?token/i.test(text)) {
    return { state: 'dead', detail: `HTTP 403 revoked: ${text.slice(0, 90)}` };
  }
  if (res.status !== 200) {
    return { state: 'indeterminate', detail: `HTTP ${res.status}: ${text.slice(0, 90)}` };
  }

  const parsed = JSON.parse(text) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { output_tokens?: number };
  };
  const said = (parsed.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  if (!said.includes('GRANT_LIVE_OK')) {
    return { state: 'indeterminate', detail: `200 but unexpected body: ${said.slice(0, 70)}` };
  }
  return {
    state: 'alive',
    detail: `200, ${parsed.usage?.output_tokens ?? '?'} output tokens, sentinel echoed`,
  };
}

async function alive(accessToken: string): Promise<boolean> {
  const { state, detail } = await probeLiveness(accessToken);
  if (state === 'indeterminate') {
    throw new Error(
      `liveness INDETERMINATE (${detail}) -- refusing to guess. Re-run when the API is healthy.`
    );
  }
  return state === 'alive';
}

/**
 * Keychain tripwire.
 *
 * The scripts here never write the keychain -- but "we don't write it" is a claim,
 * and the failure we are guarding against (a surface silently replacing the
 * developer's live credential, which then gets synced to prod within ~10s) is
 * exactly the one that has already bitten twice. So instead of trusting the claim,
 * fingerprint the credential and fail loudly the moment it moves.
 *
 * The original blob is held in memory and written to disk ONLY if a change is
 * detected -- so recovery is possible without leaving a credential lying around on
 * the happy path.
 */
function credentialFingerprint(): { raw: string; hash: string } | null {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return { raw, hash: createHash('sha256').update(raw).digest('hex').slice(0, 16) };
  } catch {
    return null;
  }
}

function makeKeychainGuard() {
  const baseline = credentialFingerprint();
  if (baseline === null) {
    console.log('  (no keychain credential found -- tripwire inactive)');
    return { check: (_label: string) => {} };
  }
  console.log(`  keychain tripwire armed (fingerprint ${baseline.hash})`);
  return {
    check(label: string): void {
      const now = credentialFingerprint();
      if (now !== null && now.hash === baseline.hash) return;
      const restorePath = join(
        dirname(new URL(import.meta.url).pathname),
        '.keychain-restore.json'
      );
      writeFileSync(restorePath, baseline.raw, { mode: 0o600 });
      console.error(
        `\n!! KEYCHAIN CHANGED during "${label}" ` +
          `(${baseline.hash} -> ${now?.hash ?? 'MISSING'}).\n` +
          'Something replaced your live Claude credential. Aborting before it can\n' +
          'be synced to prod. Your ORIGINAL blob was saved to:\n' +
          `  ${restorePath}\n\n` +
          'Restore with:\n' +
          `  security add-generic-password -U -a "$(whoami)" -s "Claude Code-credentials" \\\n` +
          `    -w "$(cat ${restorePath})"\n`
      );
      process.exit(3);
    },
  };
}

function sessionToken(): string | null {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return (
      (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth
        ?.accessToken ?? null
    );
  } catch {
    return null;
  }
}

async function main() {
  if (process.argv.includes('--mint')) {
    console.log(await mint('S1'));
    return;
  }

  const results: Array<{ check: string; pass: boolean }> = [];
  const expect = async (check: string, token: string, want: boolean) => {
    const got = await alive(token);
    const pass = got === want;
    results.push({ check, pass });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${check}`);
  };

  const session = sessionToken();
  if (session === null) {
    console.error('no interactive login found in keychain');
    process.exit(1);
  }
  console.log('\nClaude grant-independence probe (automated)\n');
  const guard = makeKeychainGuard();
  await expect('baseline: /login session token alive', session, true);

  const s1 = await mint('S1');
  guard.check('mint S1');
  await expect('S1 authenticates', s1, true);
  await expect('minting S1 did NOT revoke the /login session', sessionToken() ?? session, true);

  const s2 = await mint('S2');
  guard.check('mint S2');
  await expect('S2 authenticates', s2, true);
  await expect('THE CRUX: minting S2 did NOT revoke S1', s1, true);
  await expect('minting S2 did NOT revoke the /login session', sessionToken() ?? session, true);
  guard.check('end of run');

  const failed = results.filter((r) => !r.pass);
  const verdict = failed.length === 0 ? 'independent' : 'NOT_independent';
  writeFileSync(
    LEDGER,
    `${JSON.stringify({ iso: new Date().toISOString(), kind: 'probe-auto', results, verdict })}\n`,
    {
      flag: 'a',
      mode: 0o600,
    }
  );

  console.log(`\nRESULTS: ${results.length - failed.length}/${results.length} passed`);
  console.log(
    verdict === 'independent'
      ? '\nVERDICT: grants are INDEPENDENT -- a new authorization does not evict existing\n' +
          'ones, so a cloud-held token can coexist with the user logging in elsewhere.\n' +
          `\nPark this to track its real lifetime:\n${s1}`
      : '\nVERDICT: NOT independent -- a new authorization revoked something. The cloud\n' +
          'design cannot rely on setup-token surviving user logins.'
  );
  if (failed.length > 0) process.exit(1);
}

void main();
