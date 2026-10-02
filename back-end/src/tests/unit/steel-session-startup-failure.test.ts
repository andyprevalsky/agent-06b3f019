#!/usr/bin/env tsx
/**
 * Steel marks a session whose browser never boots `failed` (`startup_failed`)
 * seconds after creation. Validation must stop retrying CDP against that
 * session and report Steel's verdict; before this, every replacement attempt
 * waited out three 10s connect timeouts and surfaced only "Session validation
 * failed".
 *
 * Run: npx tsx src/tests/unit/steel-session-startup-failure.test.ts
 */

import assert from 'node:assert';
import type { Browser } from 'playwright';
import {
  steelStartupProbe,
  validateBrowserConnection,
} from '../../providers/steel/sessionConnection';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

function fakeBrowser(): Browser {
  return {
    contexts: () => [{ pages: () => [{}] }],
    close: async () => {},
  } as unknown as Browser;
}

const STARTUP_FAILED = 'Steel reported session s-1 failed (startup_failed)';

async function main(): Promise<void> {
  await test('validation stops at the first retry once Steel declares startup failure', async () => {
    let connects = 0;
    let probes = 0;
    const result = await validateBrowserConnection('wss://steel.example/s-1', {
      connect: async () => {
        connects += 1;
        throw new Error('Connection timeout');
      },
      startupProbe: async () => {
        probes += 1;
        return STARTUP_FAILED;
      },
    });
    assert.strictEqual(result.browser, null);
    assert.strictEqual(result.failure, STARTUP_FAILED);
    assert.strictEqual(connects, 1, 'kept dialing CDP after Steel declared the session dead');
    assert.strictEqual(probes, 1);
  });

  await test('validation keeps retrying while Steel has not ruled', async () => {
    let connects = 0;
    const result = await validateBrowserConnection('wss://steel.example/s-1', {
      connect: async () => {
        connects += 1;
        throw new Error(`connect failure ${connects}`);
      },
      startupProbe: async () => null,
    });
    assert.strictEqual(connects, 3);
    assert.strictEqual(result.browser, null);
    assert.strictEqual(result.failure, 'connect failure 3');
  });

  await test('a session that accepts CDP never pays for a status lookup', async () => {
    let probes = 0;
    const browser = fakeBrowser();
    const result = await validateBrowserConnection('wss://steel.example/s-1', {
      connect: async () => browser,
      startupProbe: async () => {
        probes += 1;
        return null;
      },
    });
    assert.strictEqual(result.browser, browser);
    assert.strictEqual(result.failure, null);
    assert.strictEqual(probes, 0);
  });

  await test('the Steel probe reports only a failed session, with its release reason', async () => {
    const probe = (session: { status: string; releaseReason?: unknown }) =>
      steelStartupProbe('s-1', async () => session)();
    assert.strictEqual(await probe({ status: 'live' }), null);
    assert.strictEqual(await probe({ status: 'released', releaseReason: 'timeout' }), null);
    assert.strictEqual(
      await probe({ status: 'failed', releaseReason: 'startup_failed' }),
      STARTUP_FAILED
    );
    assert.strictEqual(
      await probe({ status: 'failed' }),
      'Steel reported session s-1 failed (no release reason)'
    );
    const unreachable = steelStartupProbe('s-1', async () => {
      throw new Error('fetch failed');
    });
    assert.strictEqual(await unreachable(), null, 'a lookup failure must not end validation');
  });

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} failure(s):\n${failures.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n${passed} passed\n`);
}

void main();
