#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import Kernel from '@onkernel/sdk';
import { chromium } from 'playwright';
import { prisma } from '../../providers/database';
import { selectedBrowserProvider } from '../../providers/browser/config';
import {
  isKernelProxyAvailabilityError,
  kernelProxyCandidates,
  resolveKernelProxyMode,
} from '../../providers/browser/kernelProxy';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

interface BrowserMetadataResponse {
  provider?: string;
  proxy_source?: string;
  proxy_location?: { city?: string };
  profile_id?: string;
}

interface BrowserApiResponse {
  session_id?: string;
  task_id?: string;
  ws_url?: string;
  saved_url?: string;
  provider?: string;
  path?: string;
  base64_image?: string;
  same_session_available?: boolean;
  browser_session_metadata?: BrowserMetadataResponse;
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
    const init = await post('/init', {
      user_id: userId,
      agent_id: agentId,
      start_url: 'https://example.com',
    });
    liveSessionId = String(init.session_id);
    const metadata = init.browser_session_metadata ?? {};
    assert(metadata.provider === 'kernel', 'live init did not select Kernel');
    assert(metadata.proxy_source === 'kernel_residential_city', 'city proxy was not selected');
    assert(metadata.proxy_location?.city === 'san_francisco', 'city proxy was not resolved');
    profileId = metadata.profile_id;
    assert(profileId !== undefined && profileId !== '', 'Kernel profile was not persisted');

    const browser = await chromium.connectOverCDP(String(init.ws_url));
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    assert((await page.title()) === 'Example Domain', 'Kernel CDP navigation failed');
    await browser.close();

    const kernel = new Kernel({ apiKey: kernelApiKey });
    const firstRemote = await kernel.browsers.retrieve(liveSessionId, { include_deleted: true });
    proxyId = firstRemote.proxy_id ?? undefined;
    assert(proxyId !== undefined, 'Kernel browser did not use the managed proxy');

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

    const resumed = await post('/resume', { task_id: init.task_id });
    liveSessionId = String(resumed.session_id);
    const resumedMetadata = resumed.browser_session_metadata ?? {};
    assert(resumed.task_id === init.task_id, 'resume changed the stable task ID');
    assert(resumed.saved_url === 'https://example.com/resume-check', 'resume lost the saved URL');
    assert(resumedMetadata.provider === 'kernel', 'resume changed providers');
    assert(resumedMetadata.profile_id === profileId, 'resume did not reuse the Kernel profile');
    assert(
      resumedMetadata.proxy_location?.city === 'san_francisco',
      'resume lost resolved city metadata'
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
