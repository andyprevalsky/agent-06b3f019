#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import Kernel from '@onkernel/sdk';
import jwt from 'jsonwebtoken';
import { chromium, type Page } from 'playwright';
import { prisma } from '../../providers/database';
import { selectedBrowserProvider } from '../../providers/browser/config';
import {
  isKernelProxyAvailabilityError,
  kernelProxyCandidates,
  resolveKernelProxyMode,
} from '../../providers/browser/kernelProxy';
import { retryWithBackoff } from '../../providers/retry';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function isTransientKernelConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('proxy connection failed') ||
    message.includes('context deadline exceeded') ||
    message.includes('Client.Timeout exceeded')
  );
}

function isRetryableKernelNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_PROXY_CONNECTION_FAILED',
    'net::ERR_TUNNEL_CONNECTION_FAILED',
    'Timeout 30000ms exceeded',
  ].some((fragment) => message.includes(fragment));
}

async function navigateKernelPage(page: Page, url: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return;
    } catch (error) {
      if (attempt === 3 || !isRetryableKernelNavigationError(error)) throw error;
      await page.waitForTimeout(attempt * 1_000);
    }
  }
}

interface BrowserMetadataResponse {
  provider?: string;
  proxy_source?: string;
  proxy_location?: { country?: string; state?: string; city?: string };
  profile_id?: string;
}

interface BrowserApiResponse {
  session_id?: string;
  task_id?: string;
  debug_url?: string;
  ws_url?: string;
  saved_url?: string;
  provider?: string;
  path?: string;
  base64_image?: string;
  same_session_available?: boolean;
  resized?: boolean;
  viewport?: { width?: number; height?: number };
  browser_session_metadata?: BrowserMetadataResponse;
  // rotate_ip response fields
  proxy_tier?: string;
  rotations_used?: number;
  rotations_remaining?: number;
  rotation_message?: string;
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

async function deleteKernelResource(path: string): Promise<void> {
  const apiKey = process.env.KERNEL_API_KEY?.trim();
  if (!apiKey) return;
  const response = await fetch(`https://api.onkernel.com${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(`Kernel cleanup failed for ${path}: HTTP ${response.status}`);
  }
}

async function runLiveProviderParity(): Promise<void> {
  const baseUrl = process.env.TEST_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) return;
  const apiKey = process.env.BACKEND_API_KEY?.trim();
  const kernelApiKey = process.env.KERNEL_API_KEY?.trim();
  if (!apiKey || !kernelApiKey) {
    throw new Error('BACKEND_API_KEY and KERNEL_API_KEY are required for live provider parity');
  }

  const userId = `kernel-provider-${randomUUID()}`;
  const agentId = randomUUID();
  let liveSessionId: string | undefined;
  let profileId: string | undefined;
  let proxyId: string | undefined;
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey };

  const invalidRotation = await fetch(`${baseUrl}/api/browser-session/rotate-proxy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  assert(invalidRotation.status === 400, 'invalid rotate-proxy payload was not rejected');

  const post = async (path: string, body?: unknown): Promise<BrowserApiResponse> => {
    const response = await fetch(`${baseUrl}/api/browser-session${path}`, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json()) as BrowserApiResponse;
    if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(json)}`);
    return json;
  };
  const postWithKernelConnectionRetry = async (
    path: string,
    body?: unknown
  ): Promise<BrowserApiResponse> =>
    retryWithBackoff(() => post(path, body), {
      maxRetries: 3,
      fixedDelays: [750, 1_500],
      isRetryable: isTransientKernelConnectionError,
      component: `browser-provider:${path}`,
    });

  await prisma.user.create({ data: { userId, name: 'Kernel Provider Blackbox' } });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'Validate Kernel browser provider parity',
      proxyCountry: 'US',
      proxyState: 'CA',
      proxyCity: 'San Francisco',
    },
  });

  try {
    const init = await postWithKernelConnectionRetry('/init', {
      user_id: userId,
      agent_id: agentId,
      start_url: 'https://example.com',
    });
    liveSessionId = String(init.session_id);
    const metadata = init.browser_session_metadata ?? {};
    assert(metadata.provider === 'kernel', 'live init did not select Kernel');
    assert(
      [
        'kernel_residential_city',
        'kernel_residential_state',
        'kernel_residential_country',
      ].includes(String(metadata.proxy_source)),
      `managed residential proxy was not selected: ${String(metadata.proxy_source)}`
    );
    assert(metadata.proxy_location?.country === 'US', 'US proxy location was not resolved');
    profileId = metadata.profile_id;
    assert(profileId !== undefined && profileId !== '', 'Kernel profile was not persisted');

    const liveViewUrl = init.debug_url;
    assert(
      liveViewUrl !== undefined && liveViewUrl !== '',
      'Kernel live-view URL was not returned'
    );
    const liveViewResponse = await fetch(liveViewUrl, {
      signal: AbortSignal.timeout(15_000),
    });
    const liveViewBody = await liveViewResponse.text();
    assert(
      liveViewResponse.ok && !/session not found/i.test(liveViewBody),
      `Kernel live view was not ready: HTTP ${liveViewResponse.status} ${liveViewBody.slice(0, 200)}`
    );

    const browser = await chromium.connectOverCDP(String(init.ws_url));
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      await navigateKernelPage(page, 'https://example.com');
      assert((await page.title()) === 'Example Domain', 'Kernel CDP navigation failed');
    } finally {
      await browser.close();
    }

    const kernel = new Kernel({ apiKey: kernelApiKey });
    const firstRemote = await kernel.browsers.retrieve(liveSessionId, { include_deleted: true });
    proxyId = firstRemote.proxy_id ?? undefined;
    assert(proxyId !== undefined, 'Kernel browser did not use the managed proxy');

    // ----- rotate_ip: real IP rotation on the same profile (residential tier) -----
    const readExitIp = async (wsUrl: string): Promise<string> => {
      const b = await chromium.connectOverCDP(wsUrl);
      try {
        const ctx = b.contexts()[0];
        const p = ctx.pages()[0] ?? (await ctx.newPage());
        await navigateKernelPage(p, 'https://api.ipify.org?format=json');
        const raw = await p.evaluate(() => document.body.innerText);
        return String((JSON.parse(raw) as { ip?: string }).ip ?? '');
      } finally {
        await b.close();
      }
    };

    const ipBefore = await readExitIp(String(init.ws_url));
    assert(ipBefore !== '', 'could not read exit IP before rotation');

    const rotated = await postWithKernelConnectionRetry('/rotate-proxy', { task_id: init.task_id });
    assert(rotated.proxy_tier === 'residential', 'first rotation must be residential');
    assert(
      rotated.rotations_used === 1,
      `rotations_used should be 1, got ${rotated.rotations_used}`
    );
    assert(
      rotated.rotations_remaining === 3,
      'rotations_remaining should be 3 after first rotation'
    );
    assert(
      rotated.ws_url !== undefined && rotated.ws_url !== init.ws_url,
      'rotation must return a new ws_url'
    );
    assert(
      rotated.session_id !== undefined && rotated.session_id !== liveSessionId,
      'rotation must create a new Kernel session'
    );
    // Old browser must have been evicted (no paid-session leak).
    const evicted = await kernel.browsers.retrieve(liveSessionId, { include_deleted: true });
    assert(Boolean(evicted.deleted_at), 'superseded Kernel session was not evicted after rotation');
    liveSessionId = String(rotated.session_id);

    const ipAfter = await readExitIp(String(rotated.ws_url));
    // Residential exits vary per session; a rotation should land a different IP.
    assert(
      ipAfter !== '' && ipAfter !== ipBefore,
      `rotation did not change the exit IP (before=${ipBefore}, after=${ipAfter})`
    );

    // ----- mobile tier: verify the residential->mobile escalation ACTUALLY moves
    // the exit IP (ground truth via ipify, not the agent's self-report). The ladder
    // is residential (calls 1-2) -> mobile (calls 3-4); seed the counter to 2 so the
    // next rotation is call 3 = the mobile band. Gated on the same flag the backend
    // reads, so a mobile-disabled deploy asserts the residential fallback instead of
    // silently passing. -----
    const mobileFlag = (process.env.KERNEL_MOBILE_FALLBACK_ENABLED ?? '').trim().toLowerCase();
    const mobileOn = ['1', 'true', 'yes', 'on'].includes(mobileFlag);
    await prisma.browserSession.update({
      where: { id: String(init.task_id) },
      data: { proxyRotationCount: 2 },
    });
    const residentialIp = ipAfter;
    const mobileRotated = await postWithKernelConnectionRetry('/rotate-proxy', {
      task_id: init.task_id,
    });
    const expectedTier = mobileOn ? 'mobile' : 'residential';
    assert(
      mobileRotated.proxy_tier === expectedTier,
      `call 3 expected tier ${expectedTier}, got ${mobileRotated.proxy_tier}`
    );
    assert(
      mobileRotated.ws_url !== undefined && mobileRotated.ws_url !== rotated.ws_url,
      'mobile-band rotation must return a new ws_url'
    );
    assert(
      mobileRotated.session_id !== undefined && mobileRotated.session_id !== liveSessionId,
      'mobile-band rotation must create a new Kernel session'
    );
    const evictedResidential = await kernel.browsers.retrieve(liveSessionId, {
      include_deleted: true,
    });
    assert(
      Boolean(evictedResidential.deleted_at),
      'residential session was not evicted before the mobile-band rotation'
    );
    liveSessionId = String(mobileRotated.session_id);
    const mobileIp = await readExitIp(String(mobileRotated.ws_url));
    // The residential->mobile switch (or a third residential recycle when mobile is
    // off) must land a genuinely different egress IP. This is the exact claim the
    // agent run could not prove: that the mobile tier actually rotates the IP.
    assert(
      mobileIp !== '' && mobileIp !== residentialIp,
      `${expectedTier} rotation did not change the exit IP (residential=${residentialIp}, next=${mobileIp})`
    );
    // Print the ground-truth IP ladder so the run is a self-documenting repro of
    // the exit IP actually changing across tiers (baseline -> residential -> mobile).
    console.log(
      `[rotate_ip repro] exit IP ladder: baseline(res)=${ipBefore} ` +
        `-> rotation1(residential)=${ipAfter} ` +
        `-> rotation3(${mobileRotated.proxy_tier})=${mobileIp}`
    );

    // ----- rotation cap: seed the row at the cap and expect a 409 -----
    await prisma.browserSession.update({
      where: { id: String(init.task_id) },
      data: { proxyRotationCount: 4 },
    });
    const exhaustedResponse = await fetch(`${baseUrl}/api/browser-session/rotate-proxy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ task_id: init.task_id }),
    });
    assert(
      exhaustedResponse.status === 409,
      `expected 409 when rotation budget is exhausted, got ${exhaustedResponse.status}`
    );
    const exhaustedBody = (await exhaustedResponse.json()) as { error?: string; message?: string };
    assert(
      exhaustedBody.error === 'proxy_rotation_exhausted' &&
        String(exhaustedBody.message).includes('PROXY_ROTATION_EXHAUSTED'),
      'exhaustion response missing the structured error the agent reads'
    );

    // ----- unknown task → 404 -----
    const notFoundResponse = await fetch(`${baseUrl}/api/browser-session/rotate-proxy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ task_id: randomUUID() }),
    });
    assert(
      notFoundResponse.status === 404,
      `expected 404 for an unknown task, got ${notFoundResponse.status}`
    );

    const taskResponse = await fetch(
      `${baseUrl}/api/browser-session/task/${String(init.task_id)}?validateLive=true`,
      { headers: { 'x-api-key': apiKey } }
    );
    const task = (await taskResponse.json()) as BrowserApiResponse;
    assert(
      taskResponse.ok &&
        task.browser_session_metadata?.provider === 'kernel' &&
        task.same_session_available === true,
      'Kernel health validation failed'
    );

    const viewport = await post(`/task/${String(init.task_id)}/viewport`, {
      width: 1440,
      height: 900,
    });
    assert(viewport.resized === true, 'Kernel viewport resize was not acknowledged');
    assert(
      viewport.viewport?.width === 1440 && viewport.viewport.height === 900,
      'Kernel viewport resize response did not preserve the requested dimensions'
    );
    const resizedRemote = await kernel.browsers.retrieve(liveSessionId, { include_deleted: true });
    assert(
      resizedRemote.viewport?.width === 1440 && resizedRemote.viewport.height === 900,
      'Kernel remote viewport did not resize'
    );

    const expectedContent = 'kernel-provider-file-parity';
    const form = new FormData();
    form.append('file', new Blob([expectedContent], { type: 'text/plain' }), 'kernel-parity.txt');
    const uploadResponse = await fetch(`${baseUrl}/api/browser-session/${liveSessionId}/files`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form,
    });
    const upload = (await uploadResponse.json()) as BrowserApiResponse;
    assert(uploadResponse.ok && typeof upload.path === 'string', 'Kernel file upload failed');

    const listResponse = await fetch(`${baseUrl}/api/browser-session/${liveSessionId}/files/list`, {
      headers: { 'x-api-key': apiKey },
    });
    const listing = (await listResponse.json()) as { files?: Array<{ path: string }> };
    assert(
      listResponse.ok && listing.files?.some((file) => file.path === upload.path),
      'Kernel uploaded file was not listed'
    );

    const downloadResponse = await fetch(
      `${baseUrl}/api/browser-session/${liveSessionId}/files/content?path=${encodeURIComponent(String(upload.path))}`,
      { headers: { 'x-api-key': apiKey } }
    );
    assert(
      downloadResponse.ok && (await downloadResponse.text()) === expectedContent,
      'Kernel file download did not round-trip'
    );

    const traversalResponse = await fetch(
      `${baseUrl}/api/browser-session/${liveSessionId}/files/content?path=../etc/passwd`,
      { headers: { 'x-api-key': apiKey } }
    );
    assert(traversalResponse.status === 400, 'session file traversal was not rejected');

    const jwtSecret = process.env.SUPABASE_JWT_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    assert(jwtSecret !== undefined && supabaseUrl !== undefined, 'JWT test config is missing');
    const attackerToken = jwt.sign({}, jwtSecret, {
      algorithm: 'HS256',
      issuer: `${supabaseUrl}/auth/v1`,
      subject: `kernel-attacker-${randomUUID()}`,
      expiresIn: '5m',
    });
    const crossTenantFile = await fetch(
      `${baseUrl}/api/browser-session/${liveSessionId}/files/content?path=${encodeURIComponent(String(upload.path))}`,
      { headers: { Authorization: `Bearer ${attackerToken}` } }
    );
    assert(crossTenantFile.status === 404, 'cross-tenant session file read was not rejected');
    const crossTenantScreenshot = await fetch(
      `${baseUrl}/api/browser-session/${liveSessionId}/screenshot`,
      { method: 'POST', headers: { Authorization: `Bearer ${attackerToken}` } }
    );
    assert(crossTenantScreenshot.status === 404, 'cross-tenant screenshot was not rejected');
    const crossTenantRotation = await fetch(`${baseUrl}/api/browser-session/rotate-proxy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${attackerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ task_id: init.task_id }),
    });
    assert(crossTenantRotation.status === 404, 'cross-tenant proxy rotation was not rejected');

    const screenshot = await post(`/${liveSessionId}/screenshot`);
    assert(screenshot.provider === 'kernel', 'Kernel screenshot reported the wrong provider');
    assert(
      Buffer.from(String(screenshot.base64_image), 'base64').length > 1_000,
      'Kernel screenshot was empty'
    );

    await post('/close', {
      session_id: liveSessionId,
      pause: true,
      current_url: 'https://example.com/resume-check',
    });
    liveSessionId = undefined;

    const resumed = await postWithKernelConnectionRetry('/resume', { task_id: init.task_id });
    liveSessionId = String(resumed.session_id);
    const resumedMetadata = resumed.browser_session_metadata ?? {};
    assert(resumed.task_id === init.task_id, 'resume changed the stable task ID');
    assert(resumed.saved_url === 'https://example.com/resume-check', 'resume lost the saved URL');
    assert(resumedMetadata.provider === 'kernel', 'resume changed providers');
    assert(resumedMetadata.profile_id === profileId, 'resume did not reuse the Kernel profile');
    assert(
      resumedMetadata.proxy_source === metadata.proxy_source &&
        JSON.stringify(resumedMetadata.proxy_location) === JSON.stringify(metadata.proxy_location),
      'resume lost resolved proxy fallback metadata'
    );

    const secondRemote = await kernel.browsers.retrieve(liveSessionId, { include_deleted: true });
    assert(secondRemote.proxy_id === proxyId, 'resume did not reuse the managed proxy ID');
    await post('/close', { session_id: liveSessionId, pause: false });
    liveSessionId = undefined;
  } finally {
    if (liveSessionId) {
      await post('/close', { session_id: liveSessionId, pause: false }).catch(() => {});
    }
    if (profileId) await deleteKernelResource(`/profiles/${profileId}`).catch(() => {});
    if (proxyId) await deleteKernelResource(`/proxies/${proxyId}`).catch(() => {});
    await prisma.browserSession.deleteMany({ where: { agentId } });
    if (proxyId) await prisma.browserProviderProxy.deleteMany({ where: { proxyId } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

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
