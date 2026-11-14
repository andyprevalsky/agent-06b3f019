#!/usr/bin/env tsx
/**
 * Unit test for the shared rotation geolocation: a Kernel or Steel rotate_ip
 * must request a different managed proxy location (another US state, no city)
 * so the replacement session cannot reuse the pinned pool that returned the
 * unchanged exit IP. No DB or provider SDK involved.
 */
import assert from 'node:assert';
import {
  kernelProxyCandidates,
  kernelProxyLocationFromConfig,
  kernelProxyLocationFromKey,
  kernelRecreateProxySelection,
} from '../../providers/browser/kernelProxy';
import { ROTATION_CAP } from '../../providers/browser/rotation';
import { ROTATION_STATES, rotationGeolocation } from '../../providers/browser/rotationGeolocation';

function testRotationLeavesThePinnedCity(): void {
  // Live parity (2026-10-07): a Kernel residential rotation that re-requested the
  // agent's own city reused the cached `residential:US:TX:DALLAS` proxy and read
  // the same exit IP before and after. A rotation must request another US state
  // and no city, so its candidate ladder never contains the city-pinned proxy.
  const pinned = { country: 'US', state: 'TX', city: 'DALLAS' };
  const rotated = rotationGeolocation(pinned, 'browser-task-1', 1);
  assert.strictEqual(rotated.country, 'US');
  assert.strictEqual(rotated.city, undefined, 'rotation must drop the city');
  assert.ok(
    rotated.state !== undefined &&
      rotated.state !== 'TX' &&
      ROTATION_STATES.includes(rotated.state),
    `rotation must move to another large US state, got ${JSON.stringify(rotated)}`
  );
  const sources = kernelProxyCandidates(rotated, 'residential').map((c) => c.source);
  assert.deepStrictEqual(sources, ['kernel_residential_state', 'kernel_residential_country']);
  assert.ok(
    kernelProxyCandidates(rotated, 'residential').every(
      (c) => c.proxyKey !== 'residential:US:TX:DALLAS'
    ),
    'rotated ladder must not contain the city-pinned proxy that returned the unchanged IP'
  );

  // Resumes are untouched: no rotation type means the recorded exact proxy is kept.
  assert.deepStrictEqual(kernelRecreateProxySelection('kernel_residential_city', 'residential'), {
    exactManagedProxy: { type: 'residential', specificity: 'city' },
  });
  // Outside the US the pools key on country only; the rotation can only drop the city.
  assert.deepStrictEqual(rotationGeolocation({ country: 'GB', city: 'London' }, 'x', 1), {
    country: 'GB',
  });
}

function testEveryRotationOfATaskMovesToAnotherState(): void {
  // Live parity (2026-10-07): the step used to be picked by hashing the session
  // being replaced. The Kernel session `ociyyt6sx5uvqc1j22yq7g94` and the Steel
  // session that replaced it, `eaac6de5-290b-4bf9-bc9d-d7effdd6b147`, both hashed
  // to FL from the agent's CA, so rotations 3 and 4 asked Steel for the same pool
  // and read the same exit IP 67.190.231.12. The step is now the task's own
  // rotation count, so the rotations of one task never repeat a state.
  const homes = [
    { country: 'US', state: 'CA', city: 'San Francisco' },
    { country: 'US', state: 'TX', city: 'DALLAS' },
    { country: 'US', state: 'MT' },
    { country: 'US' },
  ];
  const tasks = [
    '11625b11-86d2-4ff6-9184-a1744e24222b',
    'ociyyt6sx5uvqc1j22yq7g94',
    'eaac6de5-290b-4bf9-bc9d-d7effdd6b147',
    ...Array.from({ length: 200 }, (_, index) => `browser-task-${index}`),
  ];
  for (const home of homes) {
    for (const task of tasks) {
      const states = Array.from(
        { length: ROTATION_CAP },
        (_, index) => rotationGeolocation(home, task, index + 1).state
      );
      assert.strictEqual(
        new Set(states).size,
        ROTATION_CAP,
        `task ${task} from ${JSON.stringify(home)} repeated a state across its rotations: ${states.join(',')}`
      );
      assert.ok(
        states.every((state) => state !== undefined && state !== home.state),
        `task ${task} rotated back onto its home state: ${states.join(',')}`
      );
    }
  }
  // Tasks start at different points, so one hot state is not every task's first stop.
  const firstStops = new Set(tasks.map((task) => rotationGeolocation(homes[0]!, task, 1).state));
  assert.ok(firstStops.size > 1, 'every task rotated to the same first state');
}

function testResumeReadsTheRotatedLocationBackFromTheProxyKey(): void {
  // After a rotation the session's proxy is the only record of where it went;
  // a resume reads that location back from the cached proxy key and rebuilds
  // the identical candidate, so it lands on the same proxy instead of the
  // agent's home location.
  for (const key of ['mobile:US:WA', 'residential:US:TX:dallas', 'residential:GB', 'isp:US']) {
    const location = kernelProxyLocationFromKey(key);
    assert.ok(location !== undefined, `location for ${key}`);
    const type = key.split(':')[0] as 'mobile' | 'residential' | 'isp';
    assert.strictEqual(kernelProxyCandidates(location, type)[0]!.proxyKey, key);
  }
  const legacyIsp = kernelProxyLocationFromKey('isp:US:CA');
  assert.ok(legacyIsp);
  assert.strictEqual(
    kernelProxyCandidates(legacyIsp, 'isp')[0]!.proxyKey,
    'isp:US',
    'legacy ISP location keys normalize to the country that Kernel actually supports'
  );
  assert.deepStrictEqual(kernelProxyLocationFromKey('mobile:US:WA'), {
    country: 'US',
    state: 'WA',
  });
  // The provider's own proxy config is preferred; it rebuilds the same key too.
  assert.deepStrictEqual(kernelProxyLocationFromConfig({ country: 'US', state: 'WA' }), {
    country: 'US',
    state: 'WA',
  });
  const dallas = kernelProxyLocationFromConfig({ country: 'US', state: 'TX', city: 'dallas' });
  assert.strictEqual(
    kernelProxyCandidates(dallas!, 'residential')[0]!.proxyKey,
    'residential:US:TX:dallas'
  );
  assert.strictEqual(kernelProxyLocationFromConfig({ server: 'http://custom' }), undefined);
  assert.strictEqual(kernelProxyLocationFromConfig(undefined), undefined);
  for (const bad of ['', 'mobile', 'mobile:us', 'vpn:US:WA', 'mobile:US:WA:seattle:extra']) {
    assert.strictEqual(
      kernelProxyLocationFromKey(bad),
      undefined,
      `rejects ${JSON.stringify(bad)}`
    );
  }
}

testRotationLeavesThePinnedCity();
testEveryRotationOfATaskMovesToAnotherState();
testResumeReadsTheRotatedLocationBackFromTheProxyKey();
process.stdout.write('PASS rotation geolocation leaves the pinned city\n');
