#!/usr/bin/env tsx
/**
 * Black-box tests for passkey runtime plumbing in the browser-session domain.
 *
 * These exercise pure domain functions directly (no Steel session needed):
 *   - repo.reservePasskeysForRealm — atomic signCount block reservation
 *   - serializePasskeys — init-payload serialization of passkey key material
 */

import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { reservePasskeysForRealm } from '../../domains/browser-session/repo';
import { getTaskInfo } from '../../domains/browser-session/service.task-info';
import { serializePasskeys } from '../../domains/browser-session/service.serializers';

config();

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

test('reservePasskeysForRealm reserves disjoint, strictly-greater signCount blocks', async () => {
  const userId = `bs-passkey-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    const pk = await prisma.passkeyCredential.create({
      data: {
        userId,
        authRealm: 'amazon.com',
        rpId: 'amazon.com',
        credentialId: `cred-${randomUUID()}`,
        encryptedPrivateKey: 'enc',
        userHandle: 'uh',
        signCount: 5,
      },
    });

    const first = await reservePasskeysForRealm(userId, 'amazon.com');
    assert(first.length === 1, 'expected one reserved passkey');
    assert(first[0].signCount === 5, `expected base 5, got ${first[0].signCount}`);
    assert(first[0].encryptedPrivateKey === 'enc', 'expected encrypted key echoed');

    // Second reservation must hand out a disjoint, strictly-greater block.
    const second = await reservePasskeysForRealm(userId, 'amazon.com');
    assert(second[0].signCount === 105, `expected disjoint base 105, got ${second[0].signCount}`);
    const row = await prisma.passkeyCredential.findUnique({ where: { id: pk.id } });
    assert(Number(row?.signCount) === 205, `expected db signCount 205, got ${row?.signCount}`);

    // Disabled passkeys are never reserved.
    await prisma.passkeyCredential.update({
      where: { id: pk.id },
      data: { disabledAt: new Date() },
    });
    const third = await reservePasskeysForRealm(userId, 'amazon.com');
    assert(third.length === 0, 'expected disabled passkey to be skipped');
  } finally {
    await prisma.passkeyCredential.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
});

test('serializePasskeys maps key material and preserves null userHandle', async () => {
  const out = serializePasskeys([
    {
      id: 'a',
      credentialId: 'c',
      encryptedPrivateKey: 'e',
      rpId: 'amazon.com',
      userHandle: 'u',
      signCount: 7,
    },
    {
      id: 'b',
      credentialId: 'c2',
      encryptedPrivateKey: 'e2',
      rpId: 'x.com',
      userHandle: null,
      signCount: 0,
    },
  ]);
  assert(out.length === 2, 'expected two serialized passkeys');
  assert(
    out[0].id === 'a' && out[0].signCount === 7 && out[0].rpId === 'amazon.com',
    'mapping mismatch'
  );
  assert(out[1].userHandle === null, 'expected null userHandle preserved');
});

test('getTaskInfo includes reserved passkeys for resumed browser sessions', async () => {
  const userId = `bs-passkey-task-${randomUUID()}`;
  const contextId = `steel-profile-${randomUUID()}`;
  await prisma.user.create({
    data: {
      userId,
      isAnonymous: true,
      name: 'Resume Shopper',
      addressLine1: '1 Main St',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94105',
    },
  });
  const context = await prisma.browserContext.create({
    data: { userId, contextId },
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: `steel-session-${randomUUID()}`,
      debugUrl: 'https://debug.steel.dev/session/live',
      wsUrl: 'ws://steel/live',
      status: 'ACTIVE',
      startUrl: 'https://www.google.com/',
      currentUrl:
        'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fcheckout',
    },
  });
  const passkey = await prisma.passkeyCredential.create({
    data: {
      userId,
      authRealm: 'amazon.com',
      rpId: 'amazon.com',
      credentialId: `cred-${randomUUID()}`,
      encryptedPrivateKey: 'encrypted-private-key',
      userHandle: 'user-handle',
      signCount: 42,
      browserSource: 'chrome',
    },
  });

  try {
    const info = await getTaskInfo(session.id);
    assert(info !== null, 'expected task info response');
    assert(
      info.auth_realm === 'amazon.com',
      `expected amazon.com auth realm, got ${info.auth_realm}`
    );
    assert(info.current_url === session.currentUrl, 'expected current_url to round trip');
    assert(info.start_url === session.startUrl, 'expected start_url to round trip');
    assert(info.user_settings?.addressLine1 === '1 Main St', 'expected user settings on resume');
    assert(info.passkeys.length === 1, `expected one passkey, got ${info.passkeys.length}`);
    assert(info.passkeys[0].id === passkey.id, 'expected passkey id to match');
    assert(info.passkeys[0].rpId === 'amazon.com', 'expected amazon rpId');
    assert(
      info.passkeys[0].signCount === 42,
      `expected reserved base 42, got ${info.passkeys[0].signCount}`
    );

    const row = await prisma.passkeyCredential.findUnique({ where: { id: passkey.id } });
    assert(Number(row?.signCount) === 142, `expected db signCount 142, got ${row?.signCount}`);
  } finally {
    await prisma.browserSession.deleteMany({ where: { id: session.id } });
    await prisma.browserContext.deleteMany({ where: { id: context.id } });
    await prisma.passkeyCredential.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
});

async function main() {
  const results: Array<{ name: string; passed: boolean; error?: string }> = [];
  for (const item of tests) {
    try {
      await item.fn();
      results.push({ name: item.name, passed: true });
      console.log(`PASS ${item.name}`);
    } catch (error) {
      results.push({
        name: item.name,
        passed: false,
        error: error instanceof Error ? error.stack || error.message : String(error),
      });
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
