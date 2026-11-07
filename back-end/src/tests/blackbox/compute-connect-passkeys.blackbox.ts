#!/usr/bin/env tsx
/**
 * Compute connect: passkey ceremonies the user cannot complete must be visible.
 *
 * Regression for the OpenAI "Verify your identity → Use passkey" dead click.
 * The connect browser carries a CDP virtual authenticator holding the user's
 * cloud-custody passkeys (google.com, github.com, ...) with Chrome's native
 * WebAuthn UI off. When a relying party asks for a passkey Rose does not hold
 * (openai.com in production), Chrome rejects `navigator.credentials.get` with
 * NotAllowedError in milliseconds and shows nothing, so the page looks frozen.
 * The connect poll must name that relying party so the modal can say why.
 *
 *   local Chromium ──CDP(browser ws)── attachCdp + seedPasskeys (real code)
 *        │
 *        └─ http://localhost/mfa  (auto get() on load, "Use passkey" retries)
 *                 │ NotAllowedError (no UI)
 *                 ▼
 *   sign-in watcher tick ──► pollResultFor(entry).passkeyUnavailableFor === 'localhost'
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { attachCdp, type CdpClient } from '../../domains/compute-grants/cdp';
import type { PasskeySeed } from '../../domains/compute-grants/cdp.passkeys';
import { pollResultFor } from '../../domains/compute-grants/connectSession.shared';
import { retryWithBackoff } from '../../providers/retry';
import type {
  ConnectProviderConfig,
  PendingConnect,
} from '../../domains/compute-grants/connectSession.types';
import { startSignInWatcher } from '../../domains/compute-grants/connectSession.watcher';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Ceremony {
  mediation: string | null;
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * OpenAI's /mfa-challenge shape: get() runs on load; when it settles without a
 * credential the page reveals "Use passkey", which simply calls get() again.
 */
const MFA_PAGE = String.raw`<!doctype html><html><body>
<h1>Verify your identity</h1>
<button id="use-passkey" hidden>Use passkey</button>
<script>
  const params = new URLSearchParams(location.search);
  const allowed = params.get('allow');
  const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  window.__ceremonies = [];
  async function ask(mediation) {
    const started = Date.now();
    const record = { mediation: mediation || null };
    window.__ceremonies.push(record);
    try {
      await navigator.credentials.get({
        ...(mediation ? { mediation } : {}),
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: 'localhost',
          allowCredentials: allowed ? [{ type: 'public-key', id: fromB64(allowed) }] : [],
          userVerification: 'required',
          timeout: 600000,
        },
      });
      record.ok = true;
    } catch (error) {
      record.ok = false;
      record.error = error.name;
    }
    record.ms = Date.now() - started;
    document.getElementById('use-passkey').hidden = false;
  }
  document.getElementById('use-passkey').onclick = () => ask();
  if (params.get('mode') === 'conditional') ask('conditional');
  else ask();
</script></body></html>`;

function passkeyFor(rpId: string): PasskeySeed {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    credentialId: randomBytes(16).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    rpId,
    signCount: 0,
    userHandle: randomBytes(8).toString('base64'),
  };
}

interface Harness {
  context: BrowserContext;
  profile: string;
  page: Page;
  cdp: CdpClient;
  server: Server;
  origin: string;
}

/** Chrome picks its own debugging port (no reserve-then-bind race) and records it here. */
async function browserWebSocketUrl(profile: string): Promise<string> {
  const [port, path] = await retryWithBackoff(
    async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'),
    { ...every100ms(50), isRetryable: () => true }
  );
  return `ws://127.0.0.1:${port}${path}`;
}

async function openHarness(): Promise<Harness> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(MFA_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  const profile = await mkdtemp(join(tmpdir(), 'compute-connect-passkeys-'));
  const context = await chromium.launchPersistentContext(profile, {
    args: ['--remote-debugging-port=0'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  // Remote providers hand the connect flow a BROWSER-level websocket; match it.
  const cdp = await attachCdp(await browserWebSocketUrl(profile));
  return { context, profile, page, cdp, server, origin };
}

async function closeHarness(h: Harness): Promise<void> {
  h.cdp.close();
  await h.context.close();
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
  await rm(h.profile, { recursive: true, force: true });
}

const CODEX_CONFIG: ConnectProviderConfig = {
  loginUrl: 'https://auth.openai.com/oauth/authorize',
  cookieUrls: ['https://chatgpt.com', 'https://auth.openai.com'],
  sessionCookie: '__Secure-next-auth.session-token',
  profileUrl: 'https://chatgpt.com/',
  authRealm: 'auth.openai.com',
};

function connectEntry(cdp: CdpClient, passkeys: PasskeySeed[]): PendingConnect {
  return {
    connectId: 'codex-blackbox',
    userId: 'blackbox-user',
    provider: 'codex',
    // No provider session: the CAPTCHA indicator sync is skipped, nothing remote is called.
    steelSessionId: null,
    cdpBase: 'local',
    liveViewUrl: 'https://live.invalid',
    release: null,
    cdp,
    passkeys,
    deadline: Date.now() + 60_000,
    stage: 'awaiting_human',
    done: false,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const every100ms = (attempts: number) => ({
  maxRetries: attempts,
  fixedDelays: Array.from({ length: attempts }, () => 100),
  component: 'compute-connect-passkeys',
});

/**
 * Run the real sign-in watcher (2s in production, 200ms here) and return the
 * pending poll result: the exact payload the connect modal renders. With
 * `until`, poll for up to 3s; without it, observe a fixed ~7-tick window.
 */
async function pollWithWatcher(
  entry: PendingConnect,
  until?: (result: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  startSignInWatcher(entry, CODEX_CONFIG, 200);
  const read = async () => pollResultFor(entry) as unknown as Record<string, unknown>;
  let result: Record<string, unknown>;
  if (until === undefined) {
    await sleep(1_500);
    result = await read();
  } else {
    result = await retryWithBackoff(read, {
      ...every100ms(30),
      shouldRetryResult: (poll) => !until(poll),
    });
  }
  entry.done = true; // the watcher clears its interval on the next tick
  await sleep(400);
  return result;
}

async function ceremonies(page: Page, count: number): Promise<Ceremony[]> {
  const settled = async () =>
    (
      await page.evaluate(() => (window as unknown as { __ceremonies: Ceremony[] }).__ceremonies)
    ).filter((c) => typeof c.ms === 'number');
  return retryWithBackoff(settled, {
    ...every100ms(100),
    shouldRetryResult: (seen) => seen.length < count,
  });
}

test('a passkey Rose does not hold is reported instead of failing silently', async () => {
  const h = await openHarness();
  try {
    // Production shape: only SSO passkeys are held; the relying party asks for its own.
    const held = [passkeyFor('google.com')];
    await h.cdp.seedPasskeys(held);
    const unknownId = randomBytes(16).toString('base64url');
    await h.cdp.navigate(`${h.origin}/mfa?allow=${unknownId}`);
    const page = h.page;
    await page.click('#use-passkey');
    const seen = await ceremonies(page, 2);
    assert(
      seen.length === 2,
      `expected the load and click ceremonies, got ${JSON.stringify(seen)}`
    );
    for (const c of seen) {
      assert(
        !c.ok && c.error === 'NotAllowedError' && c.ms < 2_000,
        `expected Chrome to reject instantly with no UI, got ${JSON.stringify(c)}`
      );
    }
    const result = await pollWithWatcher(
      connectEntry(h.cdp, held),
      (poll) => poll.passkeyUnavailableFor !== undefined
    );
    assert(
      result.passkeyUnavailableFor === 'localhost',
      `Use passkey was rejected in ${seen.map((c) => c.ms).join('/')}ms with no UI, but the connect poll ` +
        `did not name the relying party: ${JSON.stringify(result)}`
    );
  } finally {
    await closeHarness(h);
  }
});

test('a held passkey signs in and raises no notice', async () => {
  const h = await openHarness();
  try {
    const own = passkeyFor('localhost');
    const held = [passkeyFor('google.com'), own];
    await h.cdp.seedPasskeys(held);
    const allow = Buffer.from(own.credentialId, 'base64').toString('base64url');
    await h.cdp.navigate(`${h.origin}/mfa?allow=${allow}`);
    const page = h.page;
    const seen = await ceremonies(page, 1);
    assert(seen[0]?.ok === true, `expected the held passkey to sign, got ${JSON.stringify(seen)}`);
    // A host Rose holds passkeys for (Google/GitHub SSO in production) stays native.
    const getSource = await page.evaluate(() => CredentialsContainer.prototype.get.toString());
    assert(
      getSource.includes('[native code]'),
      `a page Rose can answer must not be patched: ${getSource.slice(0, 80)}`
    );
    const result = await pollWithWatcher(connectEntry(h.cdp, held));
    assert(
      result.passkeyUnavailableFor === undefined,
      `a successful ceremony must not raise a notice: ${JSON.stringify(result)}`
    );
  } finally {
    await closeHarness(h);
  }
});

test('conditional (autofill) passkey requests never raise a notice', async () => {
  const h = await openHarness();
  try {
    const held = [passkeyFor('google.com')];
    await h.cdp.seedPasskeys(held);
    await h.cdp.navigate(`${h.origin}/mfa?mode=conditional`);
    const page = h.page;
    await ceremonies(page, 1);
    const result = await pollWithWatcher(connectEntry(h.cdp, held));
    assert(
      result.passkeyUnavailableFor === undefined,
      `a background autofill request is not the user asking for a passkey: ${JSON.stringify(result)}`
    );
  } finally {
    await closeHarness(h);
  }
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\nCompute connect passkeys\n');
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`  PASS  ${item.name}`);
    } catch (error) {
      failures.push(item.name);
      console.log(
        `  FAIL  ${item.name}\n        ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  console.log(`\nRESULTS: ${passed}/${tests.length} passed`);
  process.exit(failures.length > 0 ? 1 : 0);
}

if (process.argv[1]?.includes('compute-connect-passkeys')) void main();
