/**
 * Live Tilion provider parity through the real backend routes (lane E,
 * docs/plans/active/tilion-browser-provider.md criteria B, C, D, G, I, K).
 *
 *   vendor contract ─ POST /v1/session ─ 2nd CDP → 4409 ─ REST while CDP → 409 ─ DELETE 204/204/410
 *   backend parity  ─ /init (Tilion pinned) ─ live view ─ CDP ─ 4409 ─ geo ─ rotate ×2 ─ files
 *                     ─ screenshot ─ pause/resume (state carried) ─ remote ended → resume ─ close
 *   concurrency     ─ opt-in: fill the account cap → typed TilionRateLimitError (shared prod account)
 *
 * Tilion admits one CDP client, so every step here closes its CDP client
 * before a backend call that drives the session (screenshot, files, rotate,
 * close harvest). Every allocated Tilion id is released in `finally` and the
 * run ends by proving none of them is still live on the account.
 */
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import WebSocket from 'ws';
import { prisma } from '../../providers/database';
import { buildPreferredBrowserConfig } from '../../providers/browser/challengeRecovery';
import {
  listLiveTilionSessionIds,
  releaseTilionRemoteSession,
} from '../../providers/browser/tilion';
import { retryWithBackoff } from '../../providers/retry';
import {
  assert,
  type BrowserApiResponse,
  navigateKernelPage,
  retryBackendFetch,
} from './browser-provider.helpers';

export const LOCATION = { country: 'US', state: 'CA', city: 'San Francisco' } as const;
const EXIT_IP_URL = 'https://api.ipify.org?format=json';
const DOWNLOAD_URL = 'https://www.w3.org/TR/2003/REC-PNG-20031110/iso_8859-1.txt';

function tilionBase(): string {
  return (process.env.TILION_BASE_URL?.trim() || 'https://back.tilion.dev').replace(/\/+$/, '');
}

export async function tilionApi(
  method: string,
  route: string,
  body?: unknown
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(`${tilionBase()}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.TILION_API_KEY?.trim() ?? ''}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(75_000),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 300);
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function detailSlug(body: unknown): string | undefined {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const slug = (detail as { error?: unknown }).error;
    return typeof slug === 'string' ? slug : undefined;
  }
  return undefined;
}

/**
 * How Tilion treats a second raw CDP socket while one client is attached.
 * Residential sessions close it with 4409 only after ~5.3 s (direct: ~0.26 s,
 * tilion-probe `second-client`), so the window must be well past that.
 */
export function secondCdpClientOutcome(
  wsUrl: string,
  holdMs = 15_000
): Promise<{ opened: boolean; closeCode: number | null; closeReason: string }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl);
    let opened = false;
    let settled = false;
    const finish = (closeCode: number | null, closeReason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      resolve({ opened, closeCode, closeReason });
    };
    const timer = setTimeout(() => finish(null, 'held open'), holdMs);
    socket.on('open', () => {
      opened = true;
    });
    socket.on('close', (code, reason) => finish(code, String(reason)));
    socket.on('unexpected-response', (_request, response) =>
      finish(null, `handshake HTTP ${response.statusCode ?? 'unknown'}`)
    );
    socket.on('error', (error) => finish(null, error.message));
  });
}

export async function withPage<T>(wsUrl: string, fn: (page: Page, browser: Browser) => Promise<T>) {
  const browser = await chromium.connectOverCDP(wsUrl, { timeout: 60_000 });
  try {
    const context = browser.contexts()[0];
    assert(context !== undefined, 'Tilion CDP connection has no browser context');
    const page = context.pages()[0] ?? (await context.newPage());
    return await fn(page, browser);
  } finally {
    // Disconnects this client only; the Tilion session keeps running.
    await browser.close();
  }
}

async function readExitIp(page: Page): Promise<string> {
  await navigateKernelPage(page, `${EXIT_IP_URL}&nonce=${encodeURIComponent(randomUUID())}`);
  const raw = await page.evaluate(() => document.body.innerText);
  try {
    return String((JSON.parse(raw) as { ip?: string }).ip ?? '');
  } catch {
    throw new Error(`exit-IP probe returned non-JSON body: ${raw.slice(0, 120)}`);
  }
}

/** A fresh residential exit can refuse its first tunnel (ERR_TUNNEL_CONNECTION_FAILED); retry briefly. */
function readExitIpWithRetry(wsUrl: string, previousIp?: string): Promise<string> {
  return retryWithBackoff(
    () =>
      withPage(wsUrl, async (page) => {
        const ip = await readExitIp(page);
        if (ip === '') throw new Error('Tilion exit returned an empty IP');
        if (previousIp !== undefined && ip === previousIp) {
          throw new Error(`Tilion exit IP unchanged (${ip})`);
        }
        return ip;
      }),
    {
      maxRetries: 3,
      fixedDelays: [1_000, 2_000, 3_000],
      isRetryable: () => true,
      component: 'tilion-live:exit-ip',
    }
  );
}

/**
 * Vendor facts the adapter is built on (measured by back-end/scripts/tilion-probe.ts).
 * Drift here means the adapter's single-client and release semantics are wrong.
 */
export async function assertLiveTilionVendorContract(): Promise<void> {
  const created = await tilionApi('POST', '/v1/session', { idle_timeout: 120, ttl: 600 });
  const record = created.body as { session_id?: string; connect_url?: string | null };
  assert(created.status === 201 && record.session_id, `Tilion create HTTP ${created.status}`);
  const sessionId = String(record.session_id);
  let released = false;
  try {
    const connectUrl = String(record.connect_url ?? '');
    assert(connectUrl !== '', 'Tilion create returned no connect_url (raw CDP not enabled?)');
    await withPage(connectUrl, async (page, browser) => {
      await navigateKernelPage(page, 'https://example.com');
      const second = await secondCdpClientOutcome(connectUrl);
      assert(
        second.closeCode === 4409,
        `second CDP client was not refused with 4409: ${JSON.stringify(second)}`
      );
      assert(browser.isConnected(), 'first CDP client was dropped by the refused second client');
      assert((await page.title()) === 'Example Domain', 'first CDP client stopped working');
      const shot = await tilionApi('POST', `/v1/session/${sessionId}/screenshot`, {});
      assert(
        shot.status === 409 && detailSlug(shot.body) === 'session_driven_by_client',
        `REST screenshot while CDP attached: HTTP ${shot.status} ${detailSlug(shot.body) ?? ''}`
      );
    });
    const detached = await tilionApi('POST', `/v1/session/${sessionId}/screenshot`, {
      format: 'jpeg',
      quality: 40,
    });
    assert(detached.status === 200, `REST screenshot after detach: HTTP ${detached.status}`);
    const first = await tilionApi('DELETE', `/v1/session/${sessionId}`);
    released = first.status === 204;
    const repeat = await tilionApi('DELETE', `/v1/session/${sessionId}`);
    const read = await tilionApi('GET', `/v1/session/${sessionId}`);
    assert(
      first.status === 204 && repeat.status === 204 && read.status === 410,
      `DELETE semantics drifted: ${first.status}/${repeat.status}/GET ${read.status}`
    );
  } finally {
    if (!released) await releaseTilionRemoteSession(sessionId).catch(() => undefined);
  }
  console.log(
    'PASS live Tilion vendor contract (4409, session_driven_by_client, DELETE 204/204/410)'
  );
}

/** Backend-route parity on a Tilion-pinned run, mirroring the Kernel live parity. */
export async function runLiveTilionProviderParity(): Promise<void> {
  const baseUrl = process.env.TEST_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) return;
  const apiKey = process.env.BACKEND_API_KEY?.trim();
  if (!apiKey || !process.env.TILION_API_KEY?.trim()) {
    throw new Error('BACKEND_API_KEY and TILION_API_KEY are required for live Tilion parity');
  }
  await assertLiveTilionVendorContract();

  const userId = `tilion-provider-${randomUUID()}`;
  const agentId = randomUUID();
  const allocated = new Set<string>();
  let liveSessionId: string | undefined;
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey };
  const post = async (path: string, body?: unknown): Promise<BrowserApiResponse> => {
    const response = await retryBackendFetch(`${baseUrl}/api/browser-session${path}`, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json()) as BrowserApiResponse;
    if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(json)}`);
    if (json.session_id) allocated.add(String(json.session_id));
    return json;
  };
  const get = (path: string) =>
    retryBackendFetch(`${baseUrl}/api/browser-session${path}`, {
      headers: { 'x-api-key': apiKey },
    });

  await prisma.user.create({ data: { userId, name: 'Tilion Provider Blackbox' } });
  // Pin Tilion through the persisted preference so this parity holds whatever
  // the backend's deployment default is; the default never overrides it.
  await prisma.browserContext.create({
    data: {
      userId,
      preferredBrowserConfig: {
        ...buildPreferredBrowserConfig(
          { provider: 'tilion', proxyMode: 'residential_country', tilionProxyType: 'residential' },
          LOCATION
        ),
      },
    },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'Validate Tilion browser provider parity',
      proxyCountry: LOCATION.country,
      proxyState: LOCATION.state,
      proxyCity: LOCATION.city,
    },
  });

  try {
    const init = await post('/init', {
      user_id: userId,
      agent_id: agentId,
      start_url: 'https://example.com',
    });
    liveSessionId = String(init.session_id);
    const taskId = String(init.task_id);
    const metadata = init.browser_session_metadata ?? {};
    assert(metadata.provider === 'tilion', `live init selected ${String(metadata.provider)}`);
    assert(
      /^tilion_residential_(city|state|country)$/.test(String(metadata.proxy_source)),
      `Tilion residential exit was not selected: ${String(metadata.proxy_source)}`
    );
    assert(metadata.proxy_location?.country === 'US', 'US proxy location was not resolved');

    // D: the interactive live view is a Tilion viewer page that a panel can frame.
    const liveViewUrl = String(init.debug_url ?? '');
    assert(
      liveViewUrl.startsWith(`${tilionBase()}/v1/session/${liveSessionId}/live-view?token=`),
      'Tilion live-view URL was not returned for this session'
    );
    const liveView = await fetch(liveViewUrl, { signal: AbortSignal.timeout(15_000) });
    const frameOptions = liveView.headers.get('x-frame-options');
    const csp = liveView.headers.get('content-security-policy') ?? '';
    assert(
      liveView.ok && /text\/html/.test(liveView.headers.get('content-type') ?? ''),
      `Tilion live view was not ready: HTTP ${liveView.status}`
    );
    assert(
      frameOptions === null && !/frame-ancestors/i.test(csp),
      `Tilion live view refuses framing: x-frame-options=${frameOptions} csp=${csp}`
    );

    // C2 + G: the worker's CDP socket is the only client; a second one is refused
    // without disturbing it. State set here must survive rotation and pause.
    const wsUrl = String(init.ws_url);
    await withPage(wsUrl, async (page, browser) => {
      await navigateKernelPage(page, 'https://example.com');
      assert((await page.title()) === 'Example Domain', 'Tilion CDP navigation failed');
      await page.evaluate(() => localStorage.setItem('rose_tilion_parity', 'kept'));
      const second = await secondCdpClientOutcome(wsUrl);
      assert(second.closeCode === 4409, `second CDP client: ${JSON.stringify(second)}`);
      assert(browser.isConnected(), 'first CDP client dropped after a refused second client');
    });
    const ipBefore = await readExitIpWithRetry(wsUrl);

    // G2: rotation 1 is a fresh Tilion residential exit with the browser kept.
    const rotated = await post('/rotate-proxy', { task_id: taskId });
    assert(
      rotated.provider === 'tilion' && rotated.proxy_tier === 'residential',
      `rotation 1 expected Tilion residential, got ${rotated.provider}/${rotated.proxy_tier}`
    );
    assert(
      rotated.recovery_action === 'ip_rotated' &&
        rotated.next_recovery === 'rotate_tilion_mobile_ip' &&
        rotated.rotations_used === 1,
      `rotation 1 metadata: ${JSON.stringify({
        action: rotated.recovery_action,
        next: rotated.next_recovery,
        used: rotated.rotations_used,
      })}`
    );
    // In place: rotate-ip with fresh_allocation keeps the session, CDP and storage.
    assert(
      String(rotated.session_id) === liveSessionId,
      `rotation 1 replaced the session instead of rotating in place (${String(rotated.session_id)})`
    );
    liveSessionId = String(rotated.session_id);
    const ipAfter = await readExitIpWithRetry(String(rotated.ws_url), ipBefore);
    const keptAfterRotate = await withPage(String(rotated.ws_url), async (page) => {
      await navigateKernelPage(page, 'https://example.com');
      return page.evaluate(() => localStorage.getItem('rose_tilion_parity'));
    });
    assert(keptAfterRotate === 'kept', 'rotation 1 lost the browser localStorage');

    const taskResponse = await get(`/task/${taskId}?validateLive=true`);
    const task = (await taskResponse.json()) as BrowserApiResponse;
    assert(
      taskResponse.ok &&
        task.browser_session_metadata?.provider === 'tilion' &&
        task.same_session_available === true,
      'Tilion health validation failed'
    );

    // I: Tilion admits one CDP client, so uploads are worker-owned: the backend
    // refuses them with a typed 409 and the worker sets the bytes over its own CDP.
    const form = new FormData();
    form.append('file', new Blob(['tilion-parity'], { type: 'text/plain' }), 'tilion-parity.txt');
    const refusedUpload = await retryBackendFetch(
      `${baseUrl}/api/browser-session/${liveSessionId}/files`,
      { method: 'POST', headers: { 'x-api-key': apiKey }, body: form }
    );
    const refusal = (await refusedUpload.json()) as { error?: string; provider?: string };
    assert(
      refusedUpload.status === 409 &&
        refusal.error === 'worker_owned' &&
        refusal.provider === 'tilion',
      `Tilion backend upload was not a typed worker_owned refusal: HTTP ${refusedUpload.status} ${JSON.stringify(refusal)}`
    );
    const uploaded = await withPage(String(rotated.ws_url), async (page) => {
      await navigateKernelPage(page, 'https://example.com');
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'rose-tilion-upload';
        document.body.appendChild(input);
      });
      await page.setInputFiles('#rose-tilion-upload', {
        name: 'tilion-parity.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('tilion-provider-file-parity'),
      });
      return page.evaluate(async () => {
        const file = (document.getElementById('rose-tilion-upload') as HTMLInputElement).files?.[0];
        return file ? { name: file.name, text: await file.text() } : null;
      });
    });
    assert(
      uploaded?.name === 'tilion-parity.txt' && uploaded.text === 'tilion-provider-file-parity',
      `worker-path CDP upload did not reach the page: ${JSON.stringify(uploaded)}`
    );
    // Downloads are addressed by URL and fetched through the session's own browser.
    const listResponse = await get(`/${liveSessionId}/files/list`);
    const listing = (await listResponse.json()) as { files?: unknown[] };
    assert(listResponse.ok && Array.isArray(listing.files), 'Tilion file listing failed');
    const expected = Buffer.from(
      await (await fetch(DOWNLOAD_URL, { signal: AbortSignal.timeout(30_000) })).arrayBuffer()
    );
    const contentResponse = await get(
      `/${liveSessionId}/files/content?path=${encodeURIComponent(DOWNLOAD_URL)}`
    );
    const content = Buffer.from(await contentResponse.arrayBuffer());
    assert(
      contentResponse.ok && expected.length > 1_000 && content.equals(expected),
      `Tilion download by URL did not match: HTTP ${contentResponse.status} ${content.length}/${expected.length} bytes`
    );
    const traversal = await get(`/${liveSessionId}/files/content?path=../etc/passwd`);
    assert(traversal.status === 400, 'Tilion session file traversal was not rejected');

    const screenshot = await post(`/${liveSessionId}/screenshot`);
    assert(screenshot.provider === 'tilion', 'Tilion screenshot reported the wrong provider');
    assert(
      Buffer.from(String(screenshot.base64_image), 'base64').length > 1_000,
      'Tilion screenshot was empty'
    );

    // B7: pause harvests state; resume lands on a new Tilion session with it.
    await post('/close', {
      session_id: liveSessionId,
      pause: true,
      current_url: 'https://example.com/resume-check',
    });
    const paused = await tilionApi('GET', `/v1/session/${liveSessionId}/status`);
    const pausedState = (paused.body as { state?: string } | null)?.state;
    assert(
      pausedState === 'closed' || pausedState === 'expired',
      `paused Tilion session was not released (state ${String(pausedState)})`
    );
    const resumed = await post('/resume', { task_id: taskId });
    liveSessionId = String(resumed.session_id);
    assert(resumed.task_id === taskId, 'resume changed the stable task ID');
    assert(resumed.saved_url === 'https://example.com/resume-check', 'resume lost the saved URL');
    assert(resumed.browser_session_metadata?.provider === 'tilion', 'resume changed providers');
    // Resume lands on a fresh Tilion session (a new exit), so the rotated exit itself
    // cannot be kept; the exit TIER must be. The location label may change
    // (tilion_residential_rotated_us → tilion_residential_country, reported to lane B).
    const exitTier = (source: unknown) => /^tilion_(residential|mobile)_/.exec(String(source))?.[1];
    assert(
      exitTier(resumed.browser_session_metadata?.proxy_source) !== undefined &&
        exitTier(resumed.browser_session_metadata?.proxy_source) ===
          exitTier(rotated.browser_session_metadata?.proxy_source),
      `resume lost the rotated Tilion exit tier: rotated=${String(
        rotated.browser_session_metadata?.proxy_source
      )} resumed=${String(resumed.browser_session_metadata?.proxy_source)}`
    );
    const keptAfterResume = await withPage(String(resumed.ws_url), async (page) => {
      await navigateKernelPage(page, 'https://example.com');
      return page.evaluate(() => localStorage.getItem('rose_tilion_parity'));
    });
    assert(keptAfterResume === 'kept', 'pause/resume lost the browser localStorage');

    // B7: the remote ends underneath an ACTIVE row (idle/ttl expiry); resume recreates it.
    await releaseTilionRemoteSession(liveSessionId);
    const recreated = await post('/resume', { task_id: taskId });
    assert(
      recreated.browser_session_metadata?.provider === 'tilion' &&
        String(recreated.session_id) !== liveSessionId,
      'resume after the remote ended did not create a replacement Tilion session'
    );
    liveSessionId = String(recreated.session_id);
    await withPage(String(recreated.ws_url), async (page) => {
      await navigateKernelPage(page, 'https://example.com');
      assert((await page.title()) === 'Example Domain', 'recreated Tilion session is not drivable');
    });

    // Rotation 2 (last: it replaces the live session and needs the worker's carried
    // state): a Tilion mobile exit, then the ladder leaves for Kernel.
    const ipBeforeMobile = await readExitIpWithRetry(String(recreated.ws_url));
    // The worker would capture this over its own socket; a live Tilion row must not be
    // replaced without it (TilionUncarriedStateError).
    const carriedState = await withPage(String(recreated.ws_url), async (page, browser) => {
      await navigateKernelPage(page, 'https://example.com');
      await page.evaluate(() => localStorage.setItem('rose_tilion_parity', 'carried'));
      return browser.contexts()[0]!.storageState();
    });
    const mobile = await post('/rotate-proxy', { task_id: taskId, storage_state: carriedState });
    assert(
      mobile.provider === 'tilion' &&
        mobile.proxy_tier === 'mobile' &&
        mobile.rotations_used === 2 &&
        mobile.next_recovery === 'switch_provider_to_kernel',
      `rotation 2 expected Tilion mobile then Kernel: ${JSON.stringify({
        provider: mobile.provider,
        tier: mobile.proxy_tier,
        used: mobile.rotations_used,
        next: mobile.next_recovery,
      })}`
    );
    if (String(mobile.session_id) !== liveSessionId) {
      const superseded = await tilionApi('GET', `/v1/session/${liveSessionId}/status`);
      const state = (superseded.body as { state?: string } | null)?.state;
      assert(
        state === 'closed' || state === 'expired',
        `superseded Tilion session ${liveSessionId} is still ${String(state)} (paid leak)`
      );
    }
    liveSessionId = String(mobile.session_id);
    const mobileWsUrl = String(mobile.ws_url);
    const mobileIp = await readExitIpWithRetry(mobileWsUrl, ipBeforeMobile);
    const carriedAfterMobile = await withPage(mobileWsUrl, async (page) => {
      await navigateKernelPage(page, 'https://example.com');
      return page.evaluate(() => localStorage.getItem('rose_tilion_parity'));
    });
    assert(carriedAfterMobile === 'carried', 'mobile replacement lost the carried localStorage');
    console.log(
      `[tilion rotate_ip] exit IP ladder: ${ipBefore} -> ${ipAfter} -> mobile ${mobileIp}`
    );

    await post('/close', { session_id: liveSessionId, pause: false });
    liveSessionId = undefined;
    console.log(
      `PASS live Tilion provider parity (sessions=${allocated.size}, ip ${ipBefore} -> ${ipAfter} -> ${mobileIp})`
    );
  } finally {
    if (liveSessionId) {
      await post('/close', { session_id: liveSessionId, pause: false }).catch(() => undefined);
    }
    for (const sessionId of allocated) {
      await releaseTilionRemoteSession(sessionId).catch(() => undefined);
    }
    const live = new Set(await listLiveTilionSessionIds());
    const leaked = [...allocated].filter((sessionId) => live.has(sessionId));
    await prisma.browserSession.deleteMany({ where: { agentId } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.user.deleteMany({ where: { userId } });
    assert(leaked.length === 0, `Tilion sessions still live after parity: ${leaked.join(', ')}`);
  }
}
