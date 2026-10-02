#!/usr/bin/env tsx

import nodeAssert from 'node:assert/strict';
import { createSessionWithContextUsingDependencies } from '../../providers/browser';
import { computeGrantBrowserProvider } from '../../domains/compute-grants/config';
import { retryWithBackoff } from '../../providers/retry';
import { selectedBrowserProvider } from '../../providers/browser/config';
import { kernelProxyCandidates, resolveKernelProxyMode } from '../../providers/browser/kernelProxy';
import { steel } from '../../providers/steel/session';
import {
  assert,
  assertBrowserUseRolloutOptIn,
  assertKernelCityInventoryFallback,
  assertStoredProviderFallback,
  assertKernelTimeoutFallback,
  isRetryableKernelNavigationError,
  withProvider,
} from './browser-provider.helpers';
import {
  assertFixedRotationLadder,
  isSteelCapacityRateLimit,
} from './browser-provider-rotation.support';
import { runLiveProviderParity } from './browser-provider.live.support';
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
  ['Kernel city inventory errors trigger location fallback', assertKernelCityInventoryFallback],
  ['Kernel SDK request timeouts trigger location fallback', assertKernelTimeoutFallback],
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

  if (process.env.RUN_BROWSER_USE_LIVE === '1') {
    let session: Awaited<ReturnType<typeof createBrowserUseRecoverySession>> | null = null;
    try {
      session = await createBrowserUseRecoverySession({ country: 'US' });
      const health = await getBrowserUseSessionHealth(session.sessionId);
      assert(health.status === 'active', 'Browser Use live session did not become active');
      const context = session.validationBrowser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      assert((await page.title()) === 'Example Domain', 'Browser Use live CDP navigation failed');
      const downloadPage = await context.newPage();
      const cdp = await context.newCDPSession(downloadPage);
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: '/tmp/downloads',
        eventsEnabled: true,
      });
      const downloaded = downloadPage.waitForEvent('download');
      await downloadPage
        .goto(
          'https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3Dbrowser-use-probe.txt&Content-Type=text%2Fplain',
          { waitUntil: 'commit', timeout: 20_000 }
        )
        .catch(() => {});
      await downloaded;
      const files = await retryWithBackoff(() => listBrowserUseSessionFiles(session.sessionId), {
        maxRetries: 20,
        fixedDelays: Array(19).fill(1_000),
        shouldRetryResult: (listed) =>
          !listed.some((file) => file.path.endsWith('browser-use-probe.txt')),
        component: 'Browser Use native download listing',
      });
      const file = files.find((item) => item.path.endsWith('browser-use-probe.txt'));
      assert(file !== undefined, `Browser Use did not list CDP download: ${JSON.stringify(files)}`);
      const downloadedBytes = await readBrowserUseSessionFile(session.sessionId, file.path);
      assert(downloadedBytes.length > 0, 'Browser Use download bytes are empty');
      const blobDownloaded = downloadPage.waitForEvent('download');
      await downloadPage.evaluate(() => {
        const url = URL.createObjectURL(new Blob(['browser-use-blob-proof']));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'browser-use-blob-proof.txt';
        document.documentElement.appendChild(link);
        link.click();
        link.remove();
      });
      await blobDownloaded;
      const blobFiles = await retryWithBackoff(
        () => listBrowserUseSessionFiles(session.sessionId),
        {
          maxRetries: 20,
          fixedDelays: Array(19).fill(1_000),
          shouldRetryResult: (listed) =>
            !listed.some((file) => file.path.endsWith('browser-use-blob-proof.txt')),
          component: 'Browser Use Blob download listing',
        }
      );
      const blobFile = blobFiles.find((item) => item.path.endsWith('browser-use-blob-proof.txt'));
      assert(blobFile !== undefined, 'Browser Use did not list the browser-created Blob download');
      assert(
        (await readBrowserUseSessionFile(session.sessionId, blobFile.path)).toString() ===
          'browser-use-blob-proof',
        'Browser Use Blob download bytes did not survive'
      );
      await downloadPage.evaluate(
        'document.documentElement.insertAdjacentHTML(\'beforeend\', \'<input type="file" id="browser-use-upload-check">\')'
      );
      const document = await cdp.send('DOM.getDocument');
      const input = await cdp.send('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: '#browser-use-upload-check',
      });
      assert(input.nodeId, 'Browser Use remote upload verification input unavailable');
      await cdp.send('DOM.setFileInputFiles', {
        nodeId: input.nodeId,
        files: ['/tmp/downloads/browser-use-blob-proof.txt'],
      });
      const uploadedName = await downloadPage.evaluate(
        "document.querySelector('#browser-use-upload-check').files?.[0]?.name"
      );
      assert(uploadedName === 'browser-use-blob-proof.txt', 'Browser Use remote file path failed');

      // Exercise the production solveCaptchas session option against a real
      // verifier. A populated token alone can precede an unsolved image grid;
      // Google's submitted success page is the outcome that matters.
      await page.goto('https://www.google.com/recaptcha/api2/demo', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      const anchor = page.frameLocator('iframe[title="reCAPTCHA"]').locator('#recaptcha-anchor');
      try {
        await anchor.waitFor({ state: 'visible', timeout: 15_000 });
        if ((await anchor.getAttribute('aria-checked')) !== 'true') {
          const box = await anchor.boundingBox();
          assert(box, 'Browser Use reCAPTCHA checkbox has no visible bounds');
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
        await page
          .frameLocator('iframe[title="reCAPTCHA"]')
          .locator('#recaptcha-anchor[aria-checked="true"]')
          .waitFor({ state: 'visible', timeout: 45_000 });
      } catch (error) {
        const snapshotPath = process.env.BROWSER_USE_LIVE_SCREENSHOT_PATH;
        if (snapshotPath) await page.screenshot({ path: snapshotPath }).catch(() => {});
        throw error;
      }
      const challengeFrame = page.locator('iframe[src*="/bframe"]');
      await challengeFrame.waitFor({ state: 'hidden', timeout: 30_000 });
      const verification = await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }),
        page
          .locator('form')
          .first()
          .evaluate((form: HTMLFormElement) => form.submit()),
      ]);
      assert(verification[0]?.ok(), 'Google reCAPTCHA demo did not return a successful response');
      assert(
        (await page.locator('body').innerText()).includes('Verification Success'),
        'Google reCAPTCHA demo rejected the solved challenge'
      );
      console.log(
        'PASS live Browser Use create, CDP, health, transfers, and reCAPTCHA verification'
      );
    } catch (error) {
      failed++;
      console.error(
        `FAIL live Browser Use provider: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (session) {
        await session.validationBrowser.close().catch(() => {});
        await releaseBrowserUseRemoteSession(session.sessionId).catch((error) => {
          failed++;
          console.error(`FAIL live Browser Use cleanup: ${String(error)}`);
        });
      }
    }
  }

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
