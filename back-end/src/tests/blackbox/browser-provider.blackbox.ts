#!/usr/bin/env tsx

import { APIConnectionTimeoutError } from '@onkernel/sdk';
import { selectedBrowserProvider } from '../../providers/browser/config';
import {
  isKernelProxyAvailabilityError,
  KERNEL_CREATE_REQUEST_OPTIONS,
  kernelProxyCandidates,
  resolveKernelProxyMode,
} from '../../providers/browser/kernelProxy';
import { steel } from '../../providers/steel/session';
import { assert, isRetryableKernelNavigationError, withProvider } from './browser-provider.helpers';
import {
  assertFixedRotationLadder,
  isSteelCapacityRateLimit,
} from './browser-provider-rotation.support';
import { runLiveProviderParity } from './browser-provider.live.support';

const steelUrl = (steel as unknown as { baseURL: string }).baseURL;

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
    'Steel selection requires a configured API key',
    () => {
      const previous = process.env.STEEL_API_KEY;
      delete process.env.STEEL_API_KEY;
      try {
        withProvider('steel', () => {
          let message = '';
          try {
            selectedBrowserProvider();
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          assert(message.includes('STEEL_API_KEY is required'), 'expected a Steel key error');
        });
      } finally {
        if (previous === undefined) delete process.env.STEEL_API_KEY;
        else process.env.STEEL_API_KEY = previous;
      }
    },
  ],
  [
    'Steel API client uses the live api.steel.dev origin',
    () => assert(steelUrl === 'https://api.steel.dev', `stale Steel API: ${steelUrl}`),
  ],
  [
    'rotate_ip uses the fixed Kernel residential, Kernel mobile, Steel, Steel ladder',
    assertFixedRotationLadder,
  ],
  [
    'live ladder retries only Steel concurrent-capacity 429 responses',
    () => {
      assert(
        isSteelCapacityRateLimit(
          new Error(
            '/rotate-proxy 429: {"error":"browser_provider_rate_limit","provider":"steel","message":"Browser session rate limit exceeded. Retry after delay."}'
          )
        ),
        'expected the explicit Steel capacity response to be retryable'
      );
      assert(
        !isSteelCapacityRateLimit(
          new Error(
            '/rotate-proxy 429: {"error":"browser_provider_rate_limit","provider":"kernel"}'
          )
        ),
        'another provider rate limit must fail closed'
      );
      assert(
        !isSteelCapacityRateLimit(new Error('/rotate-proxy 403: Steel authentication rejected')),
        'Steel authentication failures must fail closed'
      );
    },
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
  [
    'Kernel SDK request timeouts trigger location fallback',
    () => {
      assert(
        isKernelProxyAvailabilityError(new APIConnectionTimeoutError()),
        'APIConnectionTimeoutError must relax city→state→country'
      );
      assert(
        isKernelProxyAvailabilityError(new Error('Request timed out.')),
        'string timeout must also relax location specificity'
      );
      assert(
        KERNEL_CREATE_REQUEST_OPTIONS.maxRetries === 0 &&
          KERNEL_CREATE_REQUEST_OPTIONS.timeout === 45_000,
        'create calls must fail fast (no SDK retry multiplication into ~180s)'
      );
    },
  ],
  [
    'Kernel navigation retries only transient proxy failures',
    () => {
      assert(
        isRetryableKernelNavigationError(new Error('page.goto: net::ERR_CONNECTION_CLOSED')),
        'expected a closed proxy connection to be retryable'
      );
      assert(
        !isRetryableKernelNavigationError(new Error('Kernel CDP navigation failed')),
        'semantic navigation failures must fail closed'
      );
    },
  ],
];

async function main(): Promise<void> {
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

  try {
    await runLiveProviderParity();
    if (process.env.TEST_BASE_URL) console.log('PASS live Kernel provider parity');
  } catch (error) {
    failed++;
    console.error(
      `FAIL live Kernel provider parity: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (failed > 0) process.exit(1);
  console.log(
    `\nPassed ${tests.length + (process.env.TEST_BASE_URL ? 1 : 0)} browser provider test(s).`
  );
}

void main();
