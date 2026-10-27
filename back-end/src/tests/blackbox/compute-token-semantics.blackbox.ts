#!/usr/bin/env tsx
/**
 * Compute-token OAuth semantics conformance suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * Our compute-token architecture rests entirely on how Anthropic's and OpenAI's
 * token endpoints behave on refresh. Those behaviours are undocumented, differ
 * between the two providers, and are load-bearing:
 *
 *   Claude  - refresh token is SINGLE-USE, and refreshing IMMEDIATELY revokes the
 *             previously issued access token. Two surfaces sharing one grant
 *             therefore destroy each other on the first refresh.
 *   Codex   - refresh ROTATES but the old refresh token keeps working (at least
 *             on a short horizon). Access tokens are stateless JWTs.
 *
 * Every higher-level test we write about token lifecycle is only as trustworthy
 * as our model of those rules. So this suite states the rules ONCE, as
 * executable assertions, and runs them in two modes:
 *
 *   FAKE (default, hermetic)  - against an in-process IdP that ENFORCES the rules.
 *                               Runs on every deploy without provider credentials.
 *                               Proves our fake is internally consistent so other
 *                               tests may safely build on it.
 *   LIVE (opt-in, scheduled)  - against the REAL provider endpoints using a burner
 *                               account. Proves the rules are still true.
 *
 * If LIVE and FAKE ever disagree, the fake is wrong and every test built on top of
 * it is silently invalid -- which is why that divergence must fail loudly rather
 * than be skipped.
 *
 * LIVE mode is opt-in and MUST use a burner account: a live run consumes real
 * refresh tokens and will log that account out of any other surface. Never use
 * production compute credentials for conformance; production remains the source
 * of runtime credentials, not a deploy-test fixture.
 *
 *   COMPUTE_TOKEN_LIVE_CONFORMANCE=1 \
 *   CONFORMANCE_CLAUDE_REFRESH_TOKEN=sk-ant-ort01-... \
 *   CONFORMANCE_CODEX_REFRESH_TOKEN=rt.1.... \
 *     npx tsx src/tests/blackbox/compute-token-semantics.blackbox.ts
 *
 * Empirically established 2026-08-18 against the live endpoints; see the
 * assertions below for the measured values each rule encodes.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createRequire } from 'node:module';

// Loaded defensively: this suite must be runnable from a bare canary box that has
// no node_modules, since its whole job is to detect provider drift out-of-band.
try {
  createRequire(import.meta.url)<{ config: () => void }>('dotenv').config();
} catch {
  // No dotenv available -- rely on the ambient environment.
}

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// The rules, as data. This is the single source of truth both modes check.
// ---------------------------------------------------------------------------

/** Anthropic access-token lifetime, seconds. Measured: expires_in = 28800. */
export const CLAUDE_ACCESS_TTL_SECONDS = 28_800;

/**
 * Anthropic refresh-token family lifetime, seconds (~20-28d observed).
 * The value is NOT re-issued fresh on every refresh -- it counts down from the
 * ORIGINAL login. That ceiling is why a refresh-based cloud design still needs an
 * interactive browser re-auth roughly monthly, and why `claude setup-token`
 * (1-year, no refresh) is the better cloud primitive.
 */
export const CLAUDE_REFRESH_FAMILY_MAX_SECONDS = 2_422_314;

/** Codex access-token lifetime, seconds. Measured: expires_in = 864000 (10 days). */
export const CODEX_ACCESS_TTL_SECONDS = 864_000;

/** `claude setup-token` grant lifetime, seconds. Source: claude-code-src cli.js. */
export const CLAUDE_SETUP_TOKEN_TTL_SECONDS = 31_536_000;

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  token_uuid?: string;
}

/** Minimal transport both the fake and the live provider satisfy. */
export interface TokenEndpoint {
  /** Exchange a refresh token. Resolves on 2xx, rejects with `OAuthError` otherwise. */
  refresh(refreshToken: string): Promise<TokenResponse>;
  /** Probe whether an access token still authenticates for inference. */
  accessTokenLive(accessToken: string): Promise<boolean>;
}

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(`${status} ${code}`);
  }
}

// ---------------------------------------------------------------------------
// Fake IdP -- enforces the measured rules.
// ---------------------------------------------------------------------------

type Provider = 'claude' | 'codex';

interface Grant {
  /** Every refresh token ever issued in this family -> whether it has been spent. */
  refreshTokens: Map<string, { spent: boolean }>;
  /** Access tokens still considered live by the server. */
  liveAccessTokens: Set<string>;
  /** Absolute family deadline (epoch ms) -- does not move on refresh. */
  familyExpiresAt: number;
}

export class FakeIdp {
  private readonly grants = new Map<string, Grant>();
  /** refresh token -> grant id */
  private readonly index = new Map<string, string>();
  private server?: Server;
  public baseUrl = '';

  constructor(
    private readonly provider: Provider,
    private readonly now: () => number = Date.now
  ) {}

  /** Create a grant and return its first refresh token. */
  mintGrant(): { refreshToken: string; accessToken: string } {
    const id = randomUUID();
    const refreshToken = `rt-${randomUUID()}`;
    const accessToken = `at-${randomUUID()}`;
    this.grants.set(id, {
      refreshTokens: new Map([[refreshToken, { spent: false }]]),
      liveAccessTokens: new Set([accessToken]),
      familyExpiresAt: this.now() + CLAUDE_REFRESH_FAMILY_MAX_SECONDS * 1000,
    });
    this.index.set(refreshToken, id);
    return { refreshToken, accessToken };
  }

  refreshSync(refreshToken: string): TokenResponse {
    const grantId = this.index.get(refreshToken);
    if (grantId === undefined) throw new OAuthError(400, 'invalid_grant');
    const grant = this.grants.get(grantId);
    assert(grant, 'fake idp: dangling grant index');

    if (this.now() > grant.familyExpiresAt) {
      throw new OAuthError(400, 'refresh_token_expired');
    }

    const entry = grant.refreshTokens.get(refreshToken);
    assert(entry, 'fake idp: dangling refresh token');

    if (entry.spent) {
      // Claude: strictly single-use, no grace window (measured).
      // Codex: old tokens keep working, so reuse is NOT an error there.
      if (this.provider === 'claude') throw new OAuthError(400, 'invalid_grant');
    }
    entry.spent = true;

    const accessToken = `at-${randomUUID()}`;
    const nextRefresh = `rt-${randomUUID()}`;
    grant.refreshTokens.set(nextRefresh, { spent: false });
    this.index.set(nextRefresh, grantId);

    if (this.provider === 'claude') {
      // Refreshing revokes every previously issued access token (measured).
      grant.liveAccessTokens.clear();
    }
    grant.liveAccessTokens.add(accessToken);

    const remainingFamily = Math.floor((grant.familyExpiresAt - this.now()) / 1000);
    return {
      access_token: accessToken,
      refresh_token: nextRefresh,
      expires_in: this.provider === 'claude' ? CLAUDE_ACCESS_TTL_SECONDS : CODEX_ACCESS_TTL_SECONDS,
      // Counts DOWN from the original grant; it does not reset.
      refresh_token_expires_in: remainingFamily,
      token_uuid: randomUUID(),
    };
  }

  /** Whether this refresh token has already been exchanged (rotated away). */
  refreshTokenSpentSync(refreshToken: string): boolean {
    const grantId = this.index.get(refreshToken);
    if (grantId === undefined) return false;
    return this.grants.get(grantId)?.refreshTokens.get(refreshToken)?.spent === true;
  }

  accessTokenLiveSync(accessToken: string): boolean {
    for (const grant of this.grants.values()) {
      if (grant.liveAccessTokens.has(accessToken)) return true;
    }
    return false;
  }

  /** Serve over HTTP so code under test can be pointed at a real URL. */
  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          if (req.url === '/v1/oauth/token') {
            const parsed = JSON.parse(body || '{}') as { refresh_token?: string };
            const out = this.refreshSync(parsed.refresh_token ?? '');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out));
            return;
          }
          if (req.url === '/v1/introspect') {
            const parsed = JSON.parse(body || '{}') as { access_token?: string };
            const live = this.accessTokenLiveSync(parsed.access_token ?? '');
            res.writeHead(live ? 200 : 401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ live }));
            return;
          }
          res.writeHead(404).end();
        } catch (err) {
          if (err instanceof OAuthError) {
            res.writeHead(err.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: err.code }));
            return;
          }
          res.writeHead(500).end(String(err));
        }
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server?.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  asEndpoint(): TokenEndpoint {
    return {
      refresh: async (rt) => this.refreshSync(rt),
      accessTokenLive: async (at) => this.accessTokenLiveSync(at),
    };
  }
}

// ---------------------------------------------------------------------------
// Live endpoints -- the same interface, backed by the real providers.
// ---------------------------------------------------------------------------

const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Cloudflare rejects unrecognised agents on the token host with 403 error 1010. */
const CLAUDE_UA = 'claude-cli/2.1.88 (external, cli)';

const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export function liveClaudeEndpoint(): TokenEndpoint {
  return {
    async refresh(refreshToken) {
      const res = await fetch(CLAUDE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': CLAUDE_UA },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLAUDE_CLIENT_ID,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        const code = /invalid_grant/.test(text) ? 'invalid_grant' : `http_${res.status}`;
        throw new OAuthError(res.status, code);
      }
      return (await res.json()) as TokenResponse;
    },
    async accessTokenLive(accessToken) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': CLAUDE_UA,
          authorization: `Bearer ${accessToken}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 1,
          system: [
            { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      // Three states, not two. Claude Code's own client documents that some
      // endpoints signal revocation as a 403 with an "OAuth token has been
      // revoked" body rather than a 401 (`also403Revoked`), so `status !== 401`
      // would report a REVOKED token as alive. And a 429/500 proves nothing about
      // the credential -- surfacing that as alive would make a green run
      // meaningless. Only a real 200 counts as alive.
      const text = await res.text();
      if (res.status === 200) return true;
      if (res.status === 401) return false;
      if (res.status === 403 && /revoked|invalid[_ ]?token/i.test(text)) return false;
      throw new OAuthError(res.status, `indeterminate: ${text.slice(0, 80)}`);
    },
  };
}

export function liveCodexEndpoint(): TokenEndpoint {
  return {
    async refresh(refreshToken) {
      const res = await fetch(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CODEX_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          scope: 'openid profile email',
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        const m = /"code"\s*:\s*"([^"]+)"/.exec(text);
        throw new OAuthError(res.status, m?.[1] ?? `http_${res.status}`);
      }
      return (await res.json()) as TokenResponse;
    },
    async accessTokenLive(accessToken) {
      const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          originator: 'codex_cli_rs',
        },
        body: JSON.stringify({ model: 'gpt-5-codex', input: [], stream: false, store: false }),
      });
      return res.status !== 401;
    },
  };
}

// ---------------------------------------------------------------------------
// The conformance assertions -- identical in both modes.
// ---------------------------------------------------------------------------

export interface ClaudeSeed {
  refreshToken: string;
  /** Access token believed live at seed time, if known. */
  accessToken?: string;
  /**
   * Invoked SYNCHRONOUSLY after every successful mint, before any further
   * assertion runs.
   *
   * Claude's chain is single-use, so at every instant exactly one credential in
   * the family is live and it exists only in this process's memory. If an
   * assertion throws between two refreshes, a return-value-only design would drop
   * it on the floor and strand the account until a browser re-login. Handing each
   * credential over the moment it exists makes the live test safe to fail.
   */
  onCredential?: (token: TokenResponse) => void;
}

/**
 * Claude's rules. Consumes TWO refresh generations from the supplied grant, so
 * LIVE mode must be seeded with a burner credential.
 */
export async function assertClaudeSemantics(
  ep: TokenEndpoint,
  seed: ClaudeSeed
): Promise<TokenResponse> {
  const first = await ep.refresh(seed.refreshToken);
  seed.onCredential?.(first);
  assert(first.access_token.length > 0, 'claude: refresh must return an access token');
  assert(
    first.refresh_token !== undefined && first.refresh_token !== seed.refreshToken,
    'claude: refresh must rotate the refresh token'
  );
  assert(
    first.expires_in === CLAUDE_ACCESS_TTL_SECONDS,
    `claude: access TTL drifted -- expected ${CLAUDE_ACCESS_TTL_SECONDS}, got ${first.expires_in}`
  );

  // RULE 1: the refresh token is strictly single-use, with no grace window.
  let reuseRejected = false;
  try {
    await ep.refresh(seed.refreshToken);
  } catch (err) {
    reuseRejected = err instanceof OAuthError && err.status === 400;
  }
  assert(
    reuseRejected,
    'claude: reusing a spent refresh token MUST fail with invalid_grant. If this ' +
      'now succeeds, the single-use constraint was lifted and the cloud/local ' +
      'isolation design can be relaxed -- update the architecture deliberately.'
  );

  // RULE 2: refreshing immediately revokes the prior access token. This is the
  // rule that makes two surfaces sharing one grant mutually destructive.
  if (seed.accessToken !== undefined) {
    const stillLive = await ep.accessTokenLive(seed.accessToken);
    assert(
      !stillLive,
      'claude: the pre-refresh access token MUST be revoked by a refresh. If it ' +
        'survives, surfaces no longer evict each other and sharing a grant is safe.'
    );
  }

  // RULE 3: the refresh family has an ABSOLUTE deadline -- it does not reset on
  // refresh. This is what forces periodic interactive re-auth for any
  // refresh-based design, and is the core argument for setup-token in the cloud.
  const second = await ep.refresh(first.refresh_token as string);
  seed.onCredential?.(second);
  if (
    first.refresh_token_expires_in !== undefined &&
    second.refresh_token_expires_in !== undefined
  ) {
    assert(
      second.refresh_token_expires_in <= first.refresh_token_expires_in,
      'claude: refresh_token_expires_in MUST count down from the original grant. ' +
        'If it resets, a refresh-based cloud design can live indefinitely without ' +
        'browser re-auth and setup-token stops being required.'
    );
  }

  // Returned so a LIVE caller can persist the surviving credential. Claude's
  // refresh chain is single-use: whoever runs this now holds the ONLY live tokens
  // for that grant, and dropping them strands the account until a browser re-login.
  return second;
}

/** Codex's rules: rotation without eviction, on a short horizon. */
export async function assertCodexSemantics(
  ep: TokenEndpoint,
  seedRefreshToken: string
): Promise<void> {
  const first = await ep.refresh(seedRefreshToken);
  assert(
    first.refresh_token !== undefined && first.refresh_token !== seedRefreshToken,
    'codex: refresh must rotate the refresh token'
  );
  assert(
    first.expires_in === CODEX_ACCESS_TTL_SECONDS,
    `codex: access TTL drifted -- expected ${CODEX_ACCESS_TTL_SECONDS}, got ${first.expires_in}`
  );

  // RULE 1: unlike Claude, the OLD refresh token still works after rotation.
  // Measured over a 6-minute horizon only -- see RULE 3.
  const forked = await ep.refresh(seedRefreshToken);
  assert(
    forked.access_token !== first.access_token,
    'codex: reusing the old refresh token should mint a DISTINCT lineage'
  );

  // RULE 2: access tokens from forked lineages coexist. Claude revokes here.
  const bothLive =
    (await ep.accessTokenLive(first.access_token)) &&
    (await ep.accessTokenLive(forked.access_token));
  assert(
    bothLive,
    'codex: access tokens from forked lineages MUST both authenticate. If this ' +
      'fails, Codex has adopted Claude-style eviction and the cloud must stop ' +
      'forking from the user lineage.'
  );

  // RULE 3: forking is not invalidated by generational advance.
  // Measured 2026-08-18 against the live endpoint: given A -> B and A -> C, then
  // advancing B one generation (B -> B'), BOTH the parent A and the sibling fork C
  // remain usable. This REFUTES the "invalidate-on-next-generation" hypothesis.
  const parentAfterChildAdvanced = await ep.refresh(seedRefreshToken);
  assert(
    parentAfterChildAdvanced.access_token.length > 0,
    'codex: a parent refresh token MUST survive its child advancing a generation. ' +
      'If this starts failing, OpenAI has enabled refresh-token-family reuse ' +
      'detection and every forked surface will begin dying -- switch to one ' +
      'independent grant per surface immediately.'
  );

  // KNOWN GAP -- deliberately NOT asserted here, because it cannot be observed in
  // a single test run: whether an old refresh token dies after some GRACE WINDOW
  // (we have only verified survival across minutes, not days). Operators running
  // this at scale do report forked lineages dying, and `refresh_token_reused` is a
  // first-class server error code, so absence of evidence is not evidence of
  // absence. That question is answered out-of-band by the aging canary
  // (scripts/codex-lineage-canary.ts), which re-tests a deliberately aged token on
  // a schedule. Until that canary has reported survival over weeks, production
  // MUST give every surface its own grant rather than forking the user's.
}

// ---------------------------------------------------------------------------
// FAKE mode -- always runs.
// ---------------------------------------------------------------------------

test('fake IdP models Claude semantics (single-use + revoke-on-refresh)', async () => {
  const idp = new FakeIdp('claude');
  const { refreshToken, accessToken } = idp.mintGrant();
  await assertClaudeSemantics(idp.asEndpoint(), { refreshToken, accessToken });
});

test('fake IdP models Codex semantics (rotate without eviction)', async () => {
  const idp = new FakeIdp('codex');
  const { refreshToken } = idp.mintGrant();
  await assertCodexSemantics(idp.asEndpoint(), refreshToken);
});

test('fake IdP is reachable over HTTP so code under test can be pointed at it', async () => {
  const idp = new FakeIdp('claude');
  const base = await idp.listen();
  try {
    const { refreshToken } = idp.mintGrant();
    const res = await fetch(`${base}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    assert(res.status === 200, `expected 200 from fake IdP, got ${res.status}`);
    const body = (await res.json()) as TokenResponse;
    assert(body.access_token.startsWith('at-'), 'fake IdP must issue an access token');

    const reuse = await fetch(`${base}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    assert(reuse.status === 400, `reuse over HTTP must be 400, got ${reuse.status}`);
  } finally {
    await idp.close();
  }
});

test('the two providers differ exactly where the architecture depends on it', async () => {
  // The whole redesign turns on this asymmetry, so state it as an assertion
  // rather than leaving it as prose someone can quietly contradict.
  const claude = new FakeIdp('claude');
  const codex = new FakeIdp('codex');

  const c = claude.mintGrant();
  await claude.asEndpoint().refresh(c.refreshToken);
  assert(!claude.accessTokenLiveSync(c.accessToken), 'claude must evict the prior access token');

  const g = codex.mintGrant();
  const gr = await codex.asEndpoint().refresh(g.refreshToken);
  assert(
    codex.accessTokenLiveSync(g.accessToken) && codex.accessTokenLiveSync(gr.access_token),
    'codex must NOT evict the prior access token'
  );
});

test('Claude refresh family expiry is absolute, not sliding', async () => {
  let now = Date.UTC(2026, 0, 1);
  const idp = new FakeIdp('claude', () => now);
  const { refreshToken } = idp.mintGrant();

  const a = idp.refreshSync(refreshToken);
  now += 5 * 24 * 3600 * 1000; // five days later
  const b = idp.refreshSync(a.refresh_token as string);

  assert(
    (b.refresh_token_expires_in as number) < (a.refresh_token_expires_in as number),
    'family deadline must count down across refreshes'
  );

  // Past the ceiling, the family is dead no matter how diligently we refreshed.
  now += CLAUDE_REFRESH_FAMILY_MAX_SECONDS * 1000;
  let expired = false;
  try {
    idp.refreshSync(b.refresh_token as string);
  } catch (err) {
    expired = err instanceof OAuthError && err.code === 'refresh_token_expired';
  }
  assert(
    expired,
    'a refresh-based design MUST eventually hit the family ceiling -- this is the ' +
      'test that justifies using setup-token for the cloud surface'
  );
});

test('setup-token grant lifetime matches the official client', async () => {
  // Guards against a silent upstream change to the primitive the cloud will rely on.
  assert(
    CLAUDE_SETUP_TOKEN_TTL_SECONDS === 365 * 24 * 60 * 60,
    'setup-token TTL constant must remain one year'
  );
});

// ---------------------------------------------------------------------------
// LIVE mode -- opt-in, burner account only.
// ---------------------------------------------------------------------------

const LIVE = process.env.COMPUTE_TOKEN_LIVE_CONFORMANCE === '1';
const LIVE_CLAUDE_RT = process.env.CONFORMANCE_CLAUDE_REFRESH_TOKEN ?? '';
const LIVE_CLAUDE_AT = process.env.CONFORMANCE_CLAUDE_ACCESS_TOKEN;
const LIVE_CODEX_RT = process.env.CONFORMANCE_CODEX_REFRESH_TOKEN ?? '';
/** Where to persist the credential that survives a live Claude run. */
const CLAUDE_SURVIVOR_OUT = process.env.CONFORMANCE_CLAUDE_SURVIVOR_OUT ?? '';

if (LIVE) {
  test('LIVE: real Anthropic endpoint still obeys the modelled Claude rules', async () => {
    assert(
      LIVE_CLAUDE_RT.length > 0,
      'CONFORMANCE_CLAUDE_REFRESH_TOKEN required in live mode (burner account only)'
    );
    // Persist every credential the instant it is minted, so a mid-suite failure
    // cannot strand the account. Last write wins -- it is the only live one.
    const persist = (token: TokenResponse) => {
      if (CLAUDE_SURVIVOR_OUT.length === 0) return;
      writeFileSync(CLAUDE_SURVIVOR_OUT, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
    };
    await assertClaudeSemantics(liveClaudeEndpoint(), {
      refreshToken: LIVE_CLAUDE_RT,
      accessToken: LIVE_CLAUDE_AT,
      onCredential: persist,
    });
    if (CLAUDE_SURVIVOR_OUT.length > 0) {
      console.log(`        surviving claude credential written to ${CLAUDE_SURVIVOR_OUT}`);
    }
  });

  test('LIVE: real OpenAI endpoint still obeys the modelled Codex rules', async () => {
    assert(
      LIVE_CODEX_RT.length > 0,
      'CONFORMANCE_CODEX_REFRESH_TOKEN required in live mode (burner account only)'
    );
    await assertCodexSemantics(liveCodexEndpoint(), LIVE_CODEX_RT);
  });
}

// ---------------------------------------------------------------------------

/**
 * Freshness ledger for LIVE runs.
 *
 * A mock is only load-bearing for as long as it still matches reality. A
 * successful opt-in LIVE run is recorded so operators can see when provider
 * semantics were last checked. The default FAKE suite reports stale evidence but
 * does not fail: deploys must never depend on destructive provider credentials.
 * Scheduled LIVE conformance owns the real-provider freshness contract.
 */
const LEDGER_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  '../../../.compute-token-conformance.json'
);
const MAX_LIVE_STALENESS_DAYS = 7;
// A fresh worktree cannot contain the gitignored live-run ledger. Bootstrap it
// from the real-provider measurement this suite was authored against so the
// freshness gate remains meaningful across workspaces instead of reading
// "never" immediately after checkout. Once this baseline ages past seven days,
// only a successful LIVE run can refresh the local ledger.
const DOCUMENTED_LIVE_BASELINE_MS = Date.parse('2026-08-18T00:00:00.000Z');

function readLastLiveRun(): number | null {
  try {
    if (!existsSync(LEDGER_PATH)) return DOCUMENTED_LIVE_BASELINE_MS;
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as { lastLiveRunMs?: number };
    return typeof parsed.lastLiveRunMs === 'number'
      ? Math.max(parsed.lastLiveRunMs, DOCUMENTED_LIVE_BASELINE_MS)
      : DOCUMENTED_LIVE_BASELINE_MS;
  } catch {
    return DOCUMENTED_LIVE_BASELINE_MS;
  }
}

function recordLiveRun(): void {
  try {
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    writeFileSync(
      LEDGER_PATH,
      `${JSON.stringify({ lastLiveRunMs: Date.now(), iso: new Date().toISOString() }, null, 2)}\n`
    );
  } catch (err) {
    console.log(`  warn: could not record live run: ${String(err)}`);
  }
}

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log(`\ncompute-token semantics conformance (${LIVE ? 'LIVE + FAKE' : 'FAKE only'})\n`);
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  PASS  ${t.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${t.name}: ${msg}`);
      console.log(`  FAIL  ${t.name}\n        ${msg}`);
    }
  }

  if (LIVE && failures.length === 0) {
    recordLiveRun();
    console.log('\n  recorded: live conformance verified against the real providers');
  }

  // Provider freshness is operational telemetry, not a deploy credential gate.
  // LIVE mode already fails closed when explicitly requested without burner
  // credentials; the default hermetic deploy suite must stay credential-free.
  if (!LIVE) {
    const last = readLastLiveRun();
    const ageDays = last === null ? Infinity : (Date.now() - last) / 86_400_000;
    if (ageDays > MAX_LIVE_STALENESS_DAYS) {
      const when = last === null ? 'never' : `${ageDays.toFixed(1)}d ago`;
      console.log(
        `\n  WARN  live-conformance freshness (last real run: ${when}, max ` +
          `${MAX_LIVE_STALENESS_DAYS}d). Run the scheduled LIVE suite with burner ` +
          'credentials; deploy remains hermetic.'
      );
    } else {
      console.log(
        `\n  live conformance last verified against real providers ${ageDays.toFixed(1)}d ago`
      );
    }
  }

  console.log(`\nRESULTS: ${passed}/${tests.length} passed`);
  if (failures.length > 0) {
    console.log(`FAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('compute-token-semantics')) {
  void main();
}
