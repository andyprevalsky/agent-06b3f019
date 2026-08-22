#!/usr/bin/env tsx
/**
 * Codex browser OAuth contract.
 *
 * This guards the exact regression where "Connect ChatGPT" opened the regular
 * chatgpt.com app. A Codex compute connection must start at OpenAI's OAuth
 * authorize endpoint, keep its PKCE verifier/state, capture the localhost
 * callback from the remote browser, and persist the complete refreshable
 * auth.json envelope the Codex CLI consumes.
 */

import {
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  READ_CODEX_CALLBACK,
  buildCodexAuthorizeUrl,
  exchangeCodexAuthorizationCode,
  parseCodexCallbackUrl,
} from '../../providers/browser/codexGrantMint';
import { buildGrantCredentialJson } from '../../domains/compute-grants/repo';
import {
  CODEX_HOSTED_LOGIN_SUCCESS_URL,
  codexCallbackFulfillment,
} from '../../domains/compute-grants/cdp';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('Connect ChatGPT routes to the official Codex OAuth authorize URL', () => {
  const auth = buildCodexAuthorizeUrl();
  const url = new URL(auth.url);
  assert(url.origin === 'https://auth.openai.com', `wrong OAuth origin: ${url.origin}`);
  assert(url.pathname === '/oauth/authorize', `wrong OAuth path: ${url.pathname}`);
  assert(url.searchParams.get('client_id') === CODEX_CLIENT_ID, 'wrong Codex client id');
  assert(url.searchParams.get('redirect_uri') === CODEX_REDIRECT_URI, 'wrong redirect URI');
  assert(url.searchParams.get('response_type') === 'code', 'response_type must be code');
  assert(url.searchParams.get('code_challenge_method') === 'S256', 'PKCE must use S256');
  assert(url.searchParams.get('code_challenge') !== auth.verifier, 'PKCE verifier was exposed');
  assert(url.searchParams.get('state') === auth.state, 'OAuth state was not preserved');
  assert(url.searchParams.get('originator') === 'codex_cli_rs', 'wrong OAuth originator');
  assert(url.searchParams.get('codex_cli_simplified_flow') === 'true', 'not Codex CLI flow');
  assert(
    url.searchParams.get('scope')?.includes('offline_access'),
    'offline_access is required for a refresh token'
  );
});

test('the remote-browser callback reader only accepts the Codex localhost callback', () => {
  const evaluate = (href: string) =>
    Function('location', `return ${READ_CODEX_CALLBACK}`)({ href }) as string | null;
  assert(
    evaluate('http://localhost:1455/auth/callback?code=abc&state=state')?.includes('code=abc'),
    'expected callback was not captured'
  );
  assert(
    evaluate('https://auth.openai.com/oauth/authorize?code=wrong') === null,
    'authorize URL must never be mistaken for a callback'
  );
  assert(
    evaluate('http://localhost:9999/auth/callback?code=wrong') === null,
    'an unregistered callback port must not be accepted'
  );
});

test('callback parsing rejects a state mismatch before token exchange', () => {
  let threw = false;
  try {
    parseCodexCallbackUrl(
      'http://localhost:1455/auth/callback?code=one-time-code&state=attacker',
      'expected-state'
    );
  } catch (error) {
    threw = /state/i.test(error instanceof Error ? error.message : String(error));
  }
  assert(threw, 'state mismatch was accepted');
});

test('the callback request is intercepted before authorization navigation', () => {
  const connectSource = readFileSync(
    join(process.cwd(), 'src/domains/compute-grants/connectSession.ts'),
    'utf8'
  );
  const intercept = connectSource.indexOf('await cdp.armCodexCallback(auth.state)');
  const navigate = connectSource.indexOf('await cdp.navigate(auth.url)', intercept);
  assert(intercept >= 0, 'the localhost callback interceptor is never armed');
  assert(navigate > intercept, 'the interceptor must be armed before authorization navigation');
});

test('a valid callback is captured and redirected to the official hosted success page', () => {
  const result = codexCallbackFulfillment(
    'http://localhost:1455/auth/callback?code=one-time-code&state=expected-state',
    'expected-state'
  );
  assert(result?.responseCode === 302, 'valid callback was not redirected');
  assert(
    result.responseHeaders.some(
      (header) =>
        header.name.toLowerCase() === 'location' && header.value === CODEX_HOSTED_LOGIN_SUCCESS_URL
    ),
    'valid callback did not use the official hosted success destination'
  );
  assert(
    codexCallbackFulfillment(
      'http://localhost:1455/auth/callback?code=attacker&state=wrong-state',
      'expected-state'
    ) === null,
    'state-mismatched callback was intercepted'
  );
});

test('authorization code exchange uses PKCE and returns account identity + refresh lineage', async () => {
  const idToken = jwt({
    email: 'codex@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'chatgpt-account-123' },
  });
  let requestUrl = '';
  let requestBody = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body ?? '');
    return new Response(
      JSON.stringify({
        id_token: idToken,
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'refresh-lineage-123',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const result = await exchangeCodexAuthorizationCode(
    'one-time-code',
    'pkce-verifier',
    CODEX_REDIRECT_URI,
    fetchImpl
  );

  const body = new URLSearchParams(requestBody);
  assert(requestUrl === 'https://auth.openai.com/oauth/token', 'wrong token endpoint');
  assert(body.get('grant_type') === 'authorization_code', 'wrong exchange grant type');
  assert(body.get('code') === 'one-time-code', 'authorization code missing');
  assert(body.get('code_verifier') === 'pkce-verifier', 'PKCE verifier missing');
  assert(body.get('redirect_uri') === CODEX_REDIRECT_URI, 'redirect mismatch');
  assert(result.accountId === 'chatgpt-account-123', 'account id was not read from ID token');
  assert(result.accountEmail === 'codex@example.com', 'email was not read from ID token');
  assert(result.refreshToken === 'refresh-lineage-123', 'refresh token was dropped');
  assert(result.idToken === idToken, 'ID token was dropped');
});

test('Codex materialization produces a complete auth.json envelope', () => {
  const parsed = JSON.parse(
    buildGrantCredentialJson({
      userId: 'user',
      provider: 'codex',
      accountId: 'chatgpt-account-123',
      accountEmail: 'codex@example.com',
      accessToken: 'access-token',
      idToken: 'id-token',
      refreshToken: 'refresh-token',
      expiresInSeconds: 3600,
      poolingEnabled: false,
    })
  ) as {
    auth_mode?: string;
    tokens?: Record<string, unknown>;
    last_refresh?: string;
  };
  assert(parsed.auth_mode === 'chatgpt', 'wrong auth mode');
  assert(parsed.tokens?.id_token === 'id-token', 'ID token missing from auth.json');
  assert(parsed.tokens?.access_token === 'access-token', 'access token missing from auth.json');
  assert(parsed.tokens?.refresh_token === 'refresh-token', 'refresh token missing from auth.json');
  assert(parsed.tokens?.account_id === 'chatgpt-account-123', 'account id missing from auth.json');
  assert(typeof parsed.last_refresh === 'string', 'last_refresh missing from auth.json');
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\nCodex browser OAuth\n');
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
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1]?.includes('compute-codex-oauth')) void main();
