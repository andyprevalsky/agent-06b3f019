#!/usr/bin/env tsx
/**
 * Fingerprint injection is OFF by default.
 *
 * Impersonating the user's device on a provider browser made Google reject
 * fresh sign-ins ("This browser or app may not be secure") on Tilion and
 * Kernel. `getFingerprintInjectionData` is the single producer for the worker's
 * CDP emulation + init script, challenge recovery and resume, so with the
 * switch off it must return null without even reading the fingerprint row.
 */
import assert from 'node:assert/strict';
import { prisma } from '../../providers/database';
import { fingerprintInjectionEnabled } from '../../providers/steel/fingerprintSwitch';
import { getFingerprintInjectionData } from '../../providers/steel/files';

const ENV = 'BROWSER_AGENT_FINGERPRINT_INJECTION_ENABLED';

async function main(): Promise<void> {
  const reads: unknown[] = [];
  const delegate = prisma.integration as unknown as { findUnique: (args: unknown) => unknown };
  const original = delegate.findUnique;
  delegate.findUnique = async (args: unknown) => {
    reads.push(args);
    return {
      config: {
        fingerprint: {
          navigator: {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/156.0.0.0',
            languages: ['en-US', 'en'],
            platform: 'MacIntel',
          },
        },
      },
    };
  };
  const saved = process.env[ENV];
  try {
    // Default (unset) and explicit false: no payload, no DB read.
    delete process.env[ENV];
    assert.equal(fingerprintInjectionEnabled(), false);
    assert.equal(await getFingerprintInjectionData('user-1'), null);
    process.env[ENV] = 'false';
    assert.equal(await getFingerprintInjectionData('user-1'), null);
    assert.equal(reads.length, 0, 'disabled switch must not read the fingerprint row');

    // Explicit opt-in restores the old behaviour (reads the row, builds a payload).
    process.env[ENV] = 'true';
    assert.equal(fingerprintInjectionEnabled(), true);
    await getFingerprintInjectionData('user-1').catch(() => null);
    assert.equal(reads.length, 1, 'enabled switch reads the fingerprint row');
  } finally {
    delegate.findUnique = original;
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  throw error;
});
