#!/usr/bin/env tsx

import { selectedBrowserProvider } from '../../providers/browser/config';
import {
  isKernelProxyAvailabilityError,
  kernelProxyCandidates,
  resolveKernelProxyMode,
} from '../../providers/browser/kernelProxy';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function withProvider(value: string | undefined, test: () => void): void {
  const previous = process.env.BROWSER_PROVIDER;
  if (value === undefined) delete process.env.BROWSER_PROVIDER;
  else process.env.BROWSER_PROVIDER = value;
  try {
    test();
  } finally {
    if (previous === undefined) delete process.env.BROWSER_PROVIDER;
    else process.env.BROWSER_PROVIDER = previous;
  }
}

const tests: Array<[string, () => void]> = [
  [
    'Kernel is the default provider',
    () =>
      withProvider(undefined, () =>
        assert(selectedBrowserProvider() === 'kernel', 'expected kernel')
      ),
  ],
  [
    'Kernel is selected by one environment parameter',
    () =>
      withProvider('KERNEL', () =>
        assert(selectedBrowserProvider() === 'kernel', 'expected kernel')
      ),
  ],
  [
    'unsupported providers fail closed',
    () =>
      withProvider('unknown', () => {
        let message = '';
        try {
          selectedBrowserProvider();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        assert(
          message.includes('Unsupported BROWSER_PROVIDER'),
          'expected a provider validation error'
        );
      }),
  ],
  [
    'Kernel residential proxies fall back from city to state to country',
    () => {
      const candidates = kernelProxyCandidates({
        country: 'us',
        state: 'ca',
        city: 'San Francisco',
      });
      assert(candidates.length === 3, 'expected city, state, and country candidates');
      assert(candidates[0]?.proxyKey === 'residential:US:CA:san_francisco', 'bad city key');
      assert(candidates[0]?.config.city === 'san_francisco', 'bad city alias');
      assert(candidates[1]?.proxyKey === 'residential:US:CA', 'bad state key');
      assert(candidates[2]?.proxyKey === 'residential:US', 'bad country key');
    },
  ],
  [
    'Kernel proxy normalization drops non-US state targeting',
    () => {
      const candidates = kernelProxyCandidates({
        country: 'gb',
        state: 'London',
        city: 'St. John’s Wood',
      });
      assert(candidates.length === 2, 'expected city and country candidates');
      assert(candidates[0]?.proxyKey === 'residential:GB:st_johns_wood', 'bad non-US city key');
      assert(candidates[0]?.config.state === undefined, 'non-US state should be omitted');
    },
  ],
  [
    'explicit Kernel proxy ID bypasses managed location proxies',
    () => {
      const mode = resolveKernelProxyMode('proxy-123');
      assert(mode.kind === 'explicit', 'expected explicit proxy mode');
      assert(mode.proxyId === 'proxy-123', 'expected configured proxy ID');
    },
  ],
  [
    'Kernel city inventory errors trigger location fallback',
    () => {
      const error = new Error(
        "400 proxy configuration validation failed: city 'sanfrancisco' is not available for subdivision 'us-ca'"
      );
      assert(isKernelProxyAvailabilityError(error), 'expected proxy availability error');
    },
  ],
];

let failed = 0;
for (const [name, test] of tests) {
  try {
    test();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed > 0) process.exit(1);
console.log(`\nPassed ${tests.length} browser provider test(s).`);
