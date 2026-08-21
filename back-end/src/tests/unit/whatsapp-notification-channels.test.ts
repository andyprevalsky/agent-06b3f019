#!/usr/bin/env tsx
/**
 * Unit tests for notificationChannelsFor — the mirror-target selection that
 * decides which channels a lifecycle/onboarding notification fans out to. Pins
 * the "mirror to WhatsApp unless the number is known-unreachable, and never
 * hammer a number that can't receive" contract.
 */
import assert from 'node:assert';
import {
  notificationChannelsFor,
  isWhatsAppConfigured,
} from '../../providers/smsSupervisor/channelDelivery';

function withWhatsAppEnv(env: Record<string, string | undefined>, run: () => void): void {
  const keys = ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    run();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const CONFIGURED = { WHATSAPP_PHONE_NUMBER_ID: 'pnid', WHATSAPP_ACCESS_TOKEN: 'tok' };

function testConfiguredSelection(): void {
  withWhatsAppEnv(CONFIGURED, () => {
    assert.strictEqual(isWhatsAppConfigured(), true, 'configured when creds present');
    // known-reachable (user texted us on WhatsApp) → mirror to both
    assert.deepStrictEqual(notificationChannelsFor(true), ['SMS', 'WHATSAPP'], 'reachable -> both');
    // unknown (never texted our WhatsApp) → SMS only; don't proactively probe
    assert.deepStrictEqual(notificationChannelsFor(null), ['SMS'], 'unknown -> SMS only');
    // known-unreachable → SMS only (never hammer)
    assert.deepStrictEqual(notificationChannelsFor(false), ['SMS'], 'unreachable -> SMS only');
  });
}

function testUnconfiguredSelection(): void {
  withWhatsAppEnv({ WHATSAPP_PHONE_NUMBER_ID: undefined, WHATSAPP_ACCESS_TOKEN: undefined }, () => {
    assert.strictEqual(isWhatsAppConfigured(), false, 'not configured without creds');
    // Never target WhatsApp when the transport isn't configured.
    assert.deepStrictEqual(notificationChannelsFor(null), ['SMS'], 'unconfigured -> SMS only');
    assert.deepStrictEqual(notificationChannelsFor(true), ['SMS'], 'unconfigured -> SMS only');
  });
}

function main(): void {
  testConfiguredSelection();
  testUnconfiguredSelection();
  process.stdout.write('PASS notificationChannelsFor mirror-target selection\n');
}

main();
