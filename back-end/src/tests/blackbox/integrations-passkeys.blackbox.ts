#!/usr/bin/env tsx
/**
 * Black-box tests for POST /api/integrations/passkeys/upload — passkey ingestion
 * from the mac-app. Mirrors the encrypted-upload contract used by passwords:
 * client AES-256-CBC envelope { data, iv, key }; server re-encrypts each private
 * key with the RSA storage envelope and upserts a PasskeyCredential row.
 */

import crypto from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const ct = response.headers.get('content-type');
  const data = ct?.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function encryptPayload(payload: unknown): { data: string; iv: string; key: string } {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { data: encrypted, iv: iv.toString('hex'), key: aesKey.toString('hex') };
}

async function createAnonSession(): Promise<{ accessToken: string; userId: string }> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assert(res.status === 200, `anon auth failed: ${res.status}`);
  const body = res.data as { user: { id: string }; session: { access_token: string } };
  return { accessToken: body.session.access_token, userId: body.user.id };
}

test('POST /passkeys/upload — no auth -> 401', async () => {
  const res = await request(`${BASE_URL}/api/integrations/passkeys/upload`, { method: 'POST' });
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

test('POST /passkeys/upload — bad encryption -> 400', async () => {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/passkeys/upload`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assert(res.status === 400, `expected 400, got ${res.status}`);
});

test('POST /passkeys/upload — passkeys not array -> 400', async () => {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/passkeys/upload`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(encryptPayload({ passkeys: 'nope' })),
  });
  assert(res.status === 400, `expected 400, got ${res.status}`);
});

test('POST /passkeys/upload — empty array -> 200, count 0', async () => {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/passkeys/upload`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(encryptPayload({ passkeys: [] })),
  });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  assert((res.data as { passkeyCount: number }).passkeyCount === 0, 'expected count 0');
});

test('POST /passkeys/upload — happy path stores an encrypted PasskeyCredential', async () => {
  const { accessToken, userId } = await createAnonSession();
  const credentialId = `cred-${crypto.randomUUID()}`;
  try {
    const res = await request(`${BASE_URL}/api/integrations/passkeys/upload`, {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify(
        encryptPayload({
          passkeys: [
            {
              rpId: 'www.amazon.com',
              credentialId,
              privateKey: 'BASE64_PKCS8_PRIVATE_KEY_PLACEHOLDER',
              userHandle: 'dXNlci1oYW5kbGU=',
              signCount: 3,
              browserSource: 'cdp_virtual',
            },
          ],
        })
      ),
    });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert((res.data as { passkeyCount: number }).passkeyCount === 1, 'expected count 1');

    const row = await prisma.passkeyCredential.findFirst({ where: { userId, credentialId } });
    assert(row !== null, 'expected a PasskeyCredential row');
    assert(row.rpId === 'www.amazon.com', `expected rpId www.amazon.com, got ${row.rpId}`);
    assert(
      row.authRealm === 'amazon.com',
      `expected canonical realm amazon.com, got ${row.authRealm}`
    );
    assert(Number(row.signCount) === 3, `expected signCount 3, got ${row.signCount}`);
    // The stored key must be the RSA+AES storage envelope, not the raw key.
    assert(
      row.encryptedPrivateKey !== 'BASE64_PKCS8_PRIVATE_KEY_PLACEHOLDER',
      'private key must not be stored in plaintext'
    );
    const envelope = JSON.parse(Buffer.from(row.encryptedPrivateKey, 'base64').toString('utf8'));
    assert(
      envelope.version === 1 &&
        typeof envelope.encrypted_aes_key === 'string' &&
        typeof envelope.ciphertext === 'string',
      'expected a versioned RSA+AES envelope'
    );

    const integration = await prisma.integration.findUnique({
      where: { userId_name_accountId: { userId, name: 'cdp_virtual_passkeys', accountId: '' } },
    });
    assert(integration !== null, 'expected passkey upload to create integration');
    assert(integration.status === 'CONNECTED', `expected CONNECTED, got ${integration.status}`);
    assert(integration.isActive === true, 'expected cdp_virtual_passkeys integration to be active');
    assert(integration.lastSyncAt !== null, 'expected cdp_virtual_passkeys lastSyncAt to be set');
    assert(
      integration.lastSuccessfulSyncAt !== null,
      'expected cdp_virtual_passkeys lastSuccessfulSyncAt to be set'
    );
  } finally {
    await prisma.passkeyCredential.deleteMany({ where: { userId } });
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
});

test('POST /passkeys/upload — Apple Credential Exchange source marks Apple passkeys connected', async () => {
  const { accessToken, userId } = await createAnonSession();
  const credentialId = `apple-cred-${crypto.randomUUID()}`;
  try {
    const res = await request(`${BASE_URL}/api/integrations/passkeys/upload`, {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify(
        encryptPayload({
          passkeys: [
            {
              rpId: 'login.example.com',
              credentialId,
              privateKey: 'APPLE_CREDENTIAL_EXCHANGE_PRIVATE_KEY',
              userHandle: 'YXBwbGUtdXNlcg==',
              signCount: 0,
              browserSource: 'apple_passwords',
            },
          ],
        })
      ),
    });
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert((res.data as { passkeyCount: number }).passkeyCount === 1, 'expected count 1');

    const integration = await prisma.integration.findUnique({
      where: { userId_name_accountId: { userId, name: 'apple_passwords_passkeys', accountId: '' } },
    });
    assert(integration !== null, 'expected apple passkey upload to create integration');
    assert(integration.status === 'CONNECTED', `expected CONNECTED, got ${integration.status}`);
    assert(integration.isActive === true, 'expected apple_passwords_passkeys to be active');
    assert(integration.lastSyncAt !== null, 'expected apple_passwords_passkeys lastSyncAt');
    assert(
      integration.lastSuccessfulSyncAt !== null,
      'expected apple_passwords_passkeys lastSuccessfulSyncAt'
    );
  } finally {
    await prisma.passkeyCredential.deleteMany({ where: { userId } });
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
});

async function main() {
  const results: Array<{ name: string; passed: boolean }> = [];
  for (const item of tests) {
    try {
      await item.fn();
      results.push({ name: item.name, passed: true });
      console.log(`PASS ${item.name}`);
    } catch (error) {
      results.push({ name: item.name, passed: false });
      console.error(`FAIL ${item.name}`);
      console.error(error instanceof Error ? error.stack || error.message : String(error));
    }
  }
  await prisma.$disconnect();
  const failed = results.filter((r) => !r.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
