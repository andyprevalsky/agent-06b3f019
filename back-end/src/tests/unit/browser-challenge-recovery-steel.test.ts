#!/usr/bin/env tsx
import assert from 'node:assert';
import type { Browser } from 'playwright';
import { createSteelRecoverySession } from '../../providers/steel/sessionRecovery';

async function testSteelRecoverySessionDropsUnsupportedCity(): Promise<void> {
  const createInputs: Array<Record<string, unknown>> = [];
  const session = await createSteelRecoverySession(
    {
      proxyLocation: { country: 'US', state: 'TX', city: 'DALLAS' },
      proxyMode: 'managed',
    },
    {
      createSession: async (options) => {
        createInputs.push(options as unknown as Record<string, unknown>);
        if (createInputs.length === 1) {
          const error = new Error('400 Invalid proxy configuration') as Error & {
            status: number;
          };
          error.status = 400;
          throw error;
        }
        return {
          id: 'steel-recovery-after-city-drop',
          debugUrl: 'https://steel.example/debug/recovery',
          profileId: null,
          proxySource: 'steel',
        };
      },
      connectValidatedBrowser: async () => ({}) as Browser,
      releaseRemoteSession: async () => {},
    }
  );

  assert.strictEqual(session.sessionId, 'steel-recovery-after-city-drop');
  assert.strictEqual(
    createInputs.length,
    2,
    `expected city-drop retry, got ${createInputs.length} create attempt(s)`
  );
  const firstGeo = (createInputs[0]?.useProxy as { geolocation?: Record<string, string> })
    ?.geolocation;
  const secondGeo = (createInputs[1]?.useProxy as { geolocation?: Record<string, string> })
    ?.geolocation;
  assert.strictEqual(firstGeo?.city, 'DALLAS');
  assert.strictEqual(secondGeo?.city, undefined);
  assert.strictEqual(secondGeo?.state, 'TX');
  assert.strictEqual(secondGeo?.country, 'US');
}

async function main(): Promise<void> {
  await testSteelRecoverySessionDropsUnsupportedCity();
  process.stdout.write('PASS steel challenge recovery city-drop\n');
}

void main();
