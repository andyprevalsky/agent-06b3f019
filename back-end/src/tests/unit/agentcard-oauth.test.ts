#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Offline unit tests for the AgentCard OAuth 2.1 + PKCE primitives.
 * Verifies PKCE correctness and that grant_type / code_verifier / resource /
 * client_secret are sent exactly as the confidential-client contract requires.
 */

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generatePkce,
  isExpired,
  refreshAccessToken,
} from '../../providers/agentcard/oauth';
import { AGENTCARD_MCP_RESOURCE, AGENTCARD_TOKEN_ENDPOINT } from '../../providers/agentcard/config';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

const base64Url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

/** Capture the last token-endpoint request as a parsed form. */
function captureFetch(
  response: Record<string, unknown>,
  status = 200
): {
  fetchImpl: typeof fetch;
  last: () => { url: string; form: URLSearchParams };
} {
  let captured: { url: string; form: URLSearchParams } | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const rawBody = init?.body;
    const body =
      typeof rawBody === 'string'
        ? rawBody
        : rawBody instanceof URLSearchParams
          ? rawBody.toString()
          : '';
    captured = { url, form: new URLSearchParams(body) };
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, last: () => captured! };
}

async function main(): Promise<void> {
  await test('PKCE challenge === base64url(sha256(verifier))', () => {
    for (let i = 0; i < 5; i += 1) {
      const { verifier, challenge } = generatePkce();
      const expected = base64Url(createHash('sha256').update(verifier).digest());
      assert.strictEqual(challenge, expected);
      assert.ok(!/[+/=]/.test(verifier), 'verifier must be base64url');
      assert.ok(!/[+/=]/.test(challenge), 'challenge must be base64url');
    }
  });

  await test('buildAuthorizeUrl carries resource + S256 challenge + state', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'client-123',
        redirectUri: 'https://app.example/api/agentcard/callback',
        challenge: 'chal',
        state: 'state-xyz',
      })
    );
    assert.strictEqual(url.searchParams.get('response_type'), 'code');
    assert.strictEqual(url.searchParams.get('client_id'), 'client-123');
    assert.strictEqual(
      url.searchParams.get('redirect_uri'),
      'https://app.example/api/agentcard/callback'
    );
    assert.strictEqual(url.searchParams.get('code_challenge'), 'chal');
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
    assert.strictEqual(url.searchParams.get('resource'), AGENTCARD_MCP_RESOURCE);
    assert.strictEqual(url.searchParams.get('state'), 'state-xyz');
  });

  await test('exchangeCodeForToken sends code_verifier + resource + client_secret', async () => {
    const { fetchImpl, last } = captureFetch({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      token_type: 'bearer',
      expires_in: 86400,
    });
    const token = await exchangeCodeForToken({
      code: 'auth-code',
      redirectUri: 'https://app.example/api/agentcard/callback',
      clientId: 'client-123',
      clientSecret: 'super-secret',
      verifier: 'verifier-abc',
      fetchImpl,
    });
    const { url, form } = last();
    assert.strictEqual(url, AGENTCARD_TOKEN_ENDPOINT);
    assert.strictEqual(form.get('grant_type'), 'authorization_code');
    assert.strictEqual(form.get('code'), 'auth-code');
    assert.strictEqual(form.get('code_verifier'), 'verifier-abc');
    assert.strictEqual(form.get('resource'), AGENTCARD_MCP_RESOURCE);
    assert.strictEqual(form.get('client_secret'), 'super-secret');
    assert.strictEqual(token.accessToken, 'at-1');
    assert.strictEqual(token.refreshToken, 'rt-1');
    assert.ok(token.expiresAt > Date.now());
  });

  await test('public client omits client_secret on exchange', async () => {
    const { fetchImpl, last } = captureFetch({ access_token: 'at', token_type: 'bearer' });
    await exchangeCodeForToken({
      code: 'c',
      redirectUri: 'https://app.example/api/agentcard/callback',
      clientId: 'client-123',
      verifier: 'v',
      fetchImpl,
    });
    assert.strictEqual(last().form.get('client_secret'), null);
  });

  await test('refreshAccessToken sends resource + client_secret and rotates the refresh token', async () => {
    const { fetchImpl, last } = captureFetch({
      access_token: 'at-2',
      refresh_token: 'rt-rotated',
      token_type: 'bearer',
      expires_in: 86400,
    });
    const token = await refreshAccessToken({
      refreshToken: 'rt-old',
      clientId: 'client-123',
      clientSecret: 'super-secret',
      fetchImpl,
    });
    const { form } = last();
    assert.strictEqual(form.get('grant_type'), 'refresh_token');
    assert.strictEqual(form.get('refresh_token'), 'rt-old');
    assert.strictEqual(form.get('resource'), AGENTCARD_MCP_RESOURCE);
    assert.strictEqual(form.get('client_secret'), 'super-secret');
    assert.strictEqual(token.refreshToken, 'rt-rotated');
  });

  await test('refresh preserves the prior refresh token when the server omits one', async () => {
    const { fetchImpl } = captureFetch({ access_token: 'at-3', token_type: 'bearer' });
    const token = await refreshAccessToken({
      refreshToken: 'rt-keep',
      clientId: 'client-123',
      fetchImpl,
    });
    assert.strictEqual(token.refreshToken, 'rt-keep');
  });

  await test('token error responses surface error/error_description', async () => {
    const { fetchImpl } = captureFetch(
      { error: 'invalid_client', error_description: 'client authentication failed' },
      400
    );
    await assert.rejects(
      () => refreshAccessToken({ refreshToken: 'rt', clientId: 'c', clientSecret: 'x', fetchImpl }),
      /invalid_client.*client authentication failed/
    );
  });

  await test('token request timeouts surface as an AgentCardOAuthError', async () => {
    const timingOutFetch = (async () => {
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      throw timeout;
    }) as unknown as typeof fetch;
    await assert.rejects(
      () =>
        refreshAccessToken({
          refreshToken: 'rt',
          clientId: 'c',
          clientSecret: 'x',
          fetchImpl: timingOutFetch,
        }),
      /token request timed out/i
    );
  });

  await test('isExpired honors the skew window', () => {
    assert.strictEqual(isExpired({ expiresAt: Date.now() + 5 * 60_000 }), false);
    assert.strictEqual(isExpired({ expiresAt: Date.now() + 30_000 }), true); // within 60s skew
    assert.strictEqual(isExpired({ expiresAt: Date.now() - 1000 }), true);
  });

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\n✅ ${passed} AgentCard OAuth tests passed`);
}

void main();
