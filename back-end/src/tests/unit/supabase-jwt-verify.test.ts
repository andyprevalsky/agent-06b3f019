#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Unit tests for providers/supabaseJwt.ts.
 *
 * RCA repro: the auth middlewares verified with `algorithms: ['HS256']` only.
 * Supabase migrated to asymmetric JWT signing keys, so a real Supabase login
 * (supabase.auth.signInWithPassword — used by the chat-lifecycle ratchet)
 * returns an ES256 token that HS256-only verification rejected with 401
 * "Invalid or expired token" → the ratchet browser session stuck at
 * isFullySignedIn:false, no chat, 0 realtime bubbles → prod semantic gate red.
 *
 * verifySupabaseAccessToken now accepts BOTH the backend's HS256 tokens and
 * Supabase's ES256 tokens (via JWKS). These tests exercise both branches
 * hermetically — the ES256 path uses a locally-generated key set (no network).
 */
import assert from 'node:assert';

import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';

// SUPABASE_* must be set before importing the module under test (it reads them).
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://test-project.supabase.co';
process.env.SUPABASE_JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ?? 'test-shared-hs256-secret-value';

const ISSUER = `${process.env.SUPABASE_URL}/auth/v1`;

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

async function main(): Promise<void> {
  const { verifySupabaseAccessToken } = await import('../../providers/supabaseJwt');
  const jwtLib = (await import('jsonwebtoken')).default;

  console.log('supabase JWT verify unit tests:');

  // --- ES256 branch (Supabase-issued), verified against a local JWKS ---
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const kid = 'test-es256-kid';
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const localJwks = createLocalJWKSet({ keys: [jwk] });

  async function signEs256(
    claims: Record<string, unknown>,
    expiresIn = '1h',
    iss = ISSUER
  ): Promise<string> {
    return new SignJWT({ ...claims, aud: 'authenticated', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuer(iss)
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  }

  await test('accepts a valid ES256 (Supabase-issued) token', async () => {
    const token = await signEs256({ sub: 'ratchet-user-123' });
    const payload = await verifySupabaseAccessToken(token, localJwks);
    assert.strictEqual(payload.sub, 'ratchet-user-123');
  });

  await test('rejects an expired ES256 token', async () => {
    const token = await signEs256({ sub: 'x' }, '-1h');
    await assert.rejects(verifySupabaseAccessToken(token, localJwks));
  });

  await test('rejects an ES256 token with the wrong issuer', async () => {
    const token = await signEs256({ sub: 'x' }, '1h', 'https://evil.example/auth/v1');
    await assert.rejects(verifySupabaseAccessToken(token, localJwks));
  });

  await test('rejects an ES256 token signed by an unknown key', async () => {
    const other = await generateKeyPair('ES256');
    const token = await new SignJWT({ sub: 'x' })
      .setProtectedHeader({ alg: 'ES256', kid: 'other' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(other.privateKey);
    await assert.rejects(verifySupabaseAccessToken(token, localJwks));
  });

  // --- HS256 branch (backend-minted) — uses the real code path, no override ---
  const secret = process.env.SUPABASE_JWT_SECRET!;

  await test('accepts a valid HS256 (backend-minted) token', async () => {
    const token = jwtLib.sign({ sub: 'real-user-456', aud: 'authenticated' }, secret, {
      algorithm: 'HS256',
      issuer: ISSUER,
      expiresIn: '1h',
    });
    const payload = await verifySupabaseAccessToken(token);
    assert.strictEqual(payload.sub, 'real-user-456');
  });

  await test('rejects an HS256 token signed with the wrong secret', async () => {
    const token = jwtLib.sign({ sub: 'x', aud: 'authenticated' }, 'wrong-secret', {
      algorithm: 'HS256',
      issuer: ISSUER,
      expiresIn: '1h',
    });
    await assert.rejects(verifySupabaseAccessToken(token));
  });

  await test('rejects a malformed token', async () => {
    await assert.rejects(verifySupabaseAccessToken('not.a.jwt'));
  });

  await test('rejects an otherwise-valid ES256 token missing the sub claim', async () => {
    const token = await new SignJWT({ aud: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    await assert.rejects(verifySupabaseAccessToken(token, localJwks), /subject|sub/i);
  });

  await test('rejects an HS256 token with no exp claim', async () => {
    // No expiresIn → no exp claim. Must be rejected (a token that never expires).
    const token = jwtLib.sign({ sub: 'user', aud: 'authenticated' }, secret, {
      algorithm: 'HS256',
      issuer: ISSUER,
    });
    await assert.rejects(verifySupabaseAccessToken(token), /expiry|exp/i);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  ❌ ${f}`);
    process.exit(1);
  }
}

void main();
