#!/usr/bin/env tsx

import nodeAssert from 'node:assert/strict';
import { assertBrowserUseMissingHealth } from './browser-provider.browser-use-health.support';
import { assertSteelProfileReplacementLifecycle } from './browser-provider.steel-profile-lifecycle.support';
import { assertKernelProxyHealthFallback } from './browser-provider.kernel-health.support';
import { createSessionWithContextUsingDependencies } from '../../providers/browser';
import { computeGrantBrowserProvider } from '../../domains/compute-grants/config';
import { selectedBrowserProvider } from '../../providers/browser/config';
import {
  kernelProxyCandidates,
  kernelRecreateProxySelection,
  managedKernelProxyFromSource,
  resolveKernelProxyMode,
} from '../../providers/browser/kernelProxy';
import { steel } from '../../providers/steel/session';
import {
  assertSteelSameProfileReplacement,
  assert,
  assertBrowserUseDownloadFetchIsBounded,
  assertBrowserUseRolloutOptIn,
  assertKernelCityInventoryFallback,
  assertStoredProviderFallback,
  assertKernelTimeoutFallback,
  isRetryableKernelGatewayStatus,
  isRetryableKernelNavigationError,
  withProvider,
} from './browser-provider.helpers';
import {
  assertFixedRotationLadder,
  isSteelCapacityRateLimit,
  isSteelProvisioningOutage,
  isSteelSessionValidationFailure,
} from './browser-provider-rotation.support';
import { assertAuthPersistFailedInitCustody } from './browser-provider.auth-persist.cleanup.support';
import { runLiveProviderParity } from './browser-provider.live.support';
import {
  gateOverridden,
  KERNEL_RESIDENTIAL_LIVE_OVERRIDE,
  runLiveCrossProviderCases,
} from './browser-provider.tilion-live-cases.support';
import { runLiveTilionHarvest } from './browser-provider.tilion-harvest.live';
import { assertKernelUnhealthyProxyRelaxesLocation } from './browser-provider-proxy-health.support';
import { assertStaleProxyCreateFailureIsLabeled } from './browser-provider-stale-proxy.support';
import { runOptionalLiveBrowserUseProvider } from './browser-provider.browser-use-live.support';
import { tilionWiringCases } from './browser-provider.tilion-wiring.support';
import { steelAuthShareCases } from './browser-provider.steel-auth-share.support';
import {
  createBrowserUseRecoverySession,
  browserUseProxyCountry,
  getBrowserUseSessionHealth,
  listBrowserUseSessionFiles,
  readBrowserUseSessionFile,
  releaseBrowserUseRemoteSession,
} from '../../providers/browser/browserUse';

const steelUrl = (steel as unknown as { baseURL: string }).baseURL;
const browserUseFlagBeforeContractTests = process.env.BROWSER_AGENT_BROWSER_USE_ENABLED;
process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = 'true';

const tests: Array<[string, () => void | Promise<void>]> = [
  [
    'Browser Use missing health is terminal, while other failures remain errors',
    assertBrowserUseMissingHealth,
  ],
  [
    'Kernel proxy health errors preserve bounded geo fallback and cache custody',
    assertKernelProxyHealthFallback,
  ],
  [
    'Steel first-profile replacement preserves its full binding and the source on failure',
    assertSteelProfileReplacementLifecycle,
  ],
  [
    'Steel same-profile rotation releases before attachment and avoids duplicate cleanup',
    () => assertSteelSameProfileReplacement(false),
  ],
  [
    'Steel PAUSED replacement failure recovers through release404',
    () => assertSteelSameProfileReplacement(true),
  ],
  [
    'auth-persist failed-init cleanup discovers owned allocations and retains recovery custody',
    assertAuthPersistFailedInitCustody,
  ],
  // Tilion became the default for new sessions (docs/plans/completed/tilion-browser-provider.md).
  ...tilionWiringCases,
  ...steelAuthShareCases,
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
    'Browser Use selection requires a configured API key',
    () => {
      const previous = process.env.BROWSER_USE_API_KEY;
      delete process.env.BROWSER_USE_API_KEY;
      try {
        withProvider('browser-use', () => {
          let message = '';
          try {
            selectedBrowserProvider();
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          assert(
            message.includes('BROWSER_USE_API_KEY is required'),
            'expected a Browser Use key error'
          );
        });
      } finally {
        if (previous === undefined) delete process.env.BROWSER_USE_API_KEY;
        else process.env.BROWSER_USE_API_KEY = previous;
      }
    },
  ],
  [
    'Browser Use rollout flag returns default browser selection to Kernel',
    () => {
      process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = 'false';
      const previousKey = process.env.BROWSER_USE_API_KEY;
      process.env.BROWSER_USE_API_KEY = 'test-key';
      try {
        withProvider('browser-use', () =>
          assert(
            selectedBrowserProvider() === 'kernel',
            'disabled Browser Use must fall back to Kernel'
          )
        );
      } finally {
        process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = 'true';
        if (previousKey === undefined) delete process.env.BROWSER_USE_API_KEY;
        else process.env.BROWSER_USE_API_KEY = previousKey;
      }
    },
  ],
  ['Browser Use requires an explicit enabled rollout value', assertBrowserUseRolloutOptIn],
  [
    'unknown legacy stored browser providers retain the Steel fallback',
    assertStoredProviderFallback,
  ],
  [
    'Browser Use signed download fetch is aborted by a bounded deadline',
    assertBrowserUseDownloadFetchIsBounded,
  ],
  [
    'Browser Use provisioning is blocked before any provider request when disabled',
    async () => {
      process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = 'false';
      try {
        await nodeAssert.rejects(
          createBrowserUseRecoverySession({ country: 'US' }),
          /BROWSER_AGENT_BROWSER_USE_ENABLED/
        );
      } finally {
        process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = 'true';
      }
    },
  ],
  [
    'Browser Use default dispatch creates a Browser Use session',
    async () => {
      let calls = 0;
      const session = await createSessionWithContextUsingDependencies(
        'context-1',
        'agent-1',
        { country: 'US' },
        'https://example.com',
        { taskId: 'task-1' },
        {
          readPreferredConfig: async () => null,
          defaultProvider: () => 'browser-use',
          createKernel: async () => {
            throw new Error('Kernel must not be selected');
          },
          createSteel: async () => {
            throw new Error('Steel must not be selected');
          },
          createBrowserUse: async (contextId, agentId, location, url, options) => {
            calls++;
            assert(contextId === 'context-1' && agentId === 'agent-1', 'wrong Browser Use owner');
            if (location === undefined) throw new Error('Browser Use proxy location was lost');
            assert(
              location.country === 'US' && url === 'https://example.com',
              'wrong session input'
            );
            assert(options?.taskId === 'task-1', 'preallocated task ID was lost');
            return {
              provider: 'browser-use',
              sessionId: 'browser-use-session',
              debugUrl: 'https://browser-use.example/live',
              taskId: 'task-1',
              wsUrl: 'wss://browser-use.example/cdp',
              proxySource: 'browser_use_residential_country',
              proxyLocation: location,
              profileId: null,
              profileSource: 'test',
              validationBrowser: null,
            };
          },
        }
      );
      assert(calls === 1 && session.provider === 'browser-use', 'Browser Use was not dispatched');
    },
  ],
  [
    'compute-grant browser selection accepts Browser Use',
    () => {
      const previous = process.env.COMPUTE_GRANT_BROWSER_PROVIDER;
      process.env.COMPUTE_GRANT_BROWSER_PROVIDER = 'browser-use';
      try {
        assert(
          computeGrantBrowserProvider() === 'browser-use',
          'compute grant rejected Browser Use'
        );
      } finally {
        if (previous === undefined) delete process.env.COMPUTE_GRANT_BROWSER_PROVIDER;
        else process.env.COMPUTE_GRANT_BROWSER_PROVIDER = previous;
      }
    },
  ],
  [
    'compute-grant browser selection returns to Kernel when Browser Use is disabled',
    () => {
      const previous = process.env.COMPUTE_GRANT_BROWSER_PROVIDER;
      process.env.COMPUTE_GRANT_BROWSER_PROVIDER = 'browser-use';
      process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = 'false';
      try {
        assert(
          computeGrantBrowserProvider() === 'kernel',
          'disabled Browser Use must not block compute grants'
        );
      } finally {
        process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = 'true';
        if (previous === undefined) delete process.env.COMPUTE_GRANT_BROWSER_PROVIDER;
        else process.env.COMPUTE_GRANT_BROWSER_PROVIDER = previous;
      }
    },
  ],
  [
    'rotate_ip uses the Kernel residential, Kernel mobile, Steel, Browser Use ladder',
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
    'live ladder checks a control session before classifying Steel validation failures',
    () => {
      const cdpTimeout = new Error(
        '/rotate-proxy 500: {"error":"Failed to create Steel replacement after 5 attempts: Session validation failed on attempt 5: Connection timeout"}'
      );
      assert(
        isSteelSessionValidationFailure(cdpTimeout),
        'CDP connection timeout should require a Steel control-session check'
      );
      assert(
        !isSteelProvisioningOutage(cdpTimeout),
        'CDP validation failure must not bypass the control-session check'
      );
      assert(
        !isSteelProvisioningOutage(
          new Error(
            '/rotate-proxy 500: {"error":"Failed to create Steel replacement after 5 attempts: Session validation failed on attempt 5"}'
          )
        ),
        'unexplained validation failure must remain blocking'
      );
      assert(
        !isSteelProvisioningOutage(
          new Error(
            '/rotate-proxy 403: {"error":"Failed to create Steel replacement: Authentication rejected"}'
          )
        ),
        'Steel auth rejection must remain blocking'
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
    'Kernel resume keeps the resolved proxy tier and fallback location',
    () => {
      const resolved = managedKernelProxyFromSource('kernel_mobile_state');
      assert(
        resolved?.type === 'mobile' && resolved.specificity === 'state',
        'lost mobile state fallback'
      );
      assert(
        managedKernelProxyFromSource('kernel_configured') === undefined,
        'configured proxy must keep its configured selection'
      );
      const resume = kernelRecreateProxySelection('kernel_mobile_state', 'mobile');
      assert(
        resume.exactManagedProxy?.type === 'mobile' &&
          resume.exactManagedProxy.specificity === 'state',
        'resume must select the recorded mobile state proxy'
      );
      assert(
        kernelRecreateProxySelection(null, 'mobile').forceManagedProxyType === 'mobile',
        'legacy rotated sessions must stay on mobile'
      );
      assert(
        kernelRecreateProxySelection(null, 'residential').forceManagedProxyType === 'residential',
        'legacy rotated sessions must stay on residential'
      );
      assert(
        kernelRecreateProxySelection('kernel_configured', 'mobile').forceManagedProxyType ===
          undefined,
        'configured proxy must not switch to managed mobile'
      );
      assert(
        kernelRecreateProxySelection('kernel_mobile_state', 'mobile', 'residential')
          .forceManagedProxyType === 'residential',
        'a new rotation must override the recorded proxy choice'
      );
    },
  ],
  [
    'explicit Kernel proxy ID bypasses managed location proxies',
    () => {
      const mode = resolveKernelProxyMode('proxy-123');
      if (mode.kind !== 'explicit') throw new Error('expected explicit proxy mode');
      assert(mode.proxyId === 'proxy-123', 'expected configured proxy ID');
    },
  ],
  ['Kernel city inventory errors trigger location fallback', assertKernelCityInventoryFallback],
  [
    'Kernel proxy marked unavailable by its health check relaxes location and drops the cached row',
    assertKernelUnhealthyProxyRelaxesLocation,
  ],
  ['Kernel SDK request timeouts trigger location fallback', assertKernelTimeoutFallback],
  [
    'stale-proxy leg labels a rejected throwaway Kernel proxy create with the call, tier and config',
    assertStaleProxyCreateFailureIsLabeled,
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
      assert(
        [502, 503, 504].every(isRetryableKernelGatewayStatus),
        'expected proxy gateway error pages to be retryable'
      );
      assert(
        [null, 200, 403, 404, 500].every((status) => !isRetryableKernelGatewayStatus(status)),
        'non-gateway statuses must fail closed'
      );
    },
  ],
];

async function main(): Promise<void> {
  let failed = 0;
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.BROWSER_USE_API_KEY;
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    process.env.BROWSER_USE_API_KEY = 'test-browser-use-key';
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.hostname === 'download.example') return new Response('file contents');
      if (init?.method === 'POST') {
        return Response.json(
          {
            id: '00000000-0000-4000-8000-000000000002',
            cdpUrl: 'ws://127.0.0.1:9/unreachable',
            liveUrl: 'https://live.browser-use.com/test',
            status: 'active',
            startedAt: '2026-10-01T00:00:00Z',
            timeoutAt: '2026-10-01T04:00:00Z',
          },
          { status: 201 }
        );
      }
      if (init?.method === 'PATCH') return Response.json({ status: 'stopped' });
      if (url.pathname.endsWith('/downloads')) {
        return Response.json({
          files: [
            {
              path: 'report.pdf',
              size: 13,
              lastModified: '2026-10-01T00:00:00Z',
              url: 'https://download.example/report.pdf',
            },
          ],
          hasMore: false,
          nextCursor: null,
        });
      }
      return Response.json({
        id: '00000000-0000-4000-8000-000000000002',
        status: 'active',
        startedAt: '2026-10-01T00:00:00Z',
        timeoutAt: '2026-10-01T04:00:00Z',
      });
    }) as typeof fetch;
    try {
      await nodeAssert.rejects(
        () => createBrowserUseRecoverySession({ country: 'US' }),
        /Browser Use CDP validation failed/
      );
      assert(
        calls[0]?.method === 'POST' && calls[0]?.path === '/api/v4/browsers',
        'Browser Use create must use V4'
      );
      assert(
        (calls[0]?.body as { proxyCountryCode?: string })?.proxyCountryCode === 'us',
        'Browser Use proxy country was not sent'
      );
      assert(
        browserUseProxyCountry({ country: 'GB', city: 'LONDON' }) === 'uk',
        'Browser Use must map ISO GB to provider UK'
      );
      assert(
        calls.some(
          (call) => call.method === 'PATCH' && (call.body as { action?: string })?.action === 'stop'
        ),
        'failed Browser Use CDP validation leaked a paid session'
      );
      const health = await getBrowserUseSessionHealth('00000000-0000-4000-8000-000000000002');
      assert(
        health.provider === 'browser-use' && health.status === 'active',
        'Browser Use health was not mapped'
      );
      const files = await listBrowserUseSessionFiles('00000000-0000-4000-8000-000000000002');
      assert(
        files.length === 1 && files[0]?.path === 'report.pdf',
        'Browser Use downloads were not listed'
      );
      const data = await readBrowserUseSessionFile(
        '00000000-0000-4000-8000-000000000002',
        'report.pdf'
      );
      assert(data.toString() === 'file contents', 'Browser Use download URL was not fetched');
      await releaseBrowserUseRemoteSession('00000000-0000-4000-8000-000000000002');
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.BROWSER_USE_API_KEY;
      else process.env.BROWSER_USE_API_KEY = previousKey;
    }
    console.log('PASS Browser Use V4 session, proxy, cleanup, health, and download contract');
  } catch (error) {
    failed++;
    console.error(
      `FAIL Browser Use V4 contract: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  failed += await runOptionalLiveBrowserUseProvider();
  failed += await runLiveTilionHarvest();

  if (process.env.RUN_BROWSER_USE_HANDOFF_LIVE === '1') {
    try {
      const { runLiveBrowserUseHandoff } =
        await import('./browser-provider.browser-use-handoff.live');
      await runLiveBrowserUseHandoff();
    } catch (error) {
      failed++;
      console.error(
        `FAIL live Browser Use handoff: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Contract cases enable Browser Use inside this process. The live ladder must
  // use the backend's original rollout setting or its expected next step drifts.
  if (browserUseFlagBeforeContractTests === undefined)
    delete process.env.BROWSER_AGENT_BROWSER_USE_ENABLED;
  else process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = browserUseFlagBeforeContractTests;
  try {
    if (process.env.TEST_BASE_URL && gateOverridden(KERNEL_RESIDENTIAL_LIVE_OVERRIDE)) {
      console.log(
        '⚠️⚠️ SKIPPED live Kernel provider parity -- explicitly overridden by ' +
          `DEPLOY_GATE_OVERRIDES=${KERNEL_RESIDENTIAL_LIVE_OVERRIDE} (Kernel residential ` +
          'proxies unavailable); NOT a pass: rerun once Kernel proxies validate'
      );
    } else {
      await runLiveProviderParity();
      if (process.env.TEST_BASE_URL) console.log('PASS live Kernel provider parity');
    }
  } catch (error) {
    failed++;
    console.error(
      `FAIL live Kernel provider parity: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  failed += await runLiveCrossProviderCases();

  if (failed > 0) process.exit(1);
  console.log(
    `\nPassed ${tests.length + (process.env.TEST_BASE_URL ? 1 : 0)} browser provider test(s).`
  );
}

void main();
