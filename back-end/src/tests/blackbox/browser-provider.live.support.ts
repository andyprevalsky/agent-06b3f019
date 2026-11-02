#!/usr/bin/env tsx

/** Live Kernel/Steel/Browser Use provider parity + rotate_ip ladder (split for max-lines). */

import { randomUUID } from 'node:crypto';
import Kernel from '@onkernel/sdk';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright';
import { prisma } from '../../providers/database';
import { browserUseEnabled } from '../../providers/browser/config';
import { buildPreferredBrowserConfig } from '../../providers/browser/challengeRecovery';
import { retryWithBackoff } from '../../providers/retry';
import {
  releaseSteelRemoteSession,
  steel,
  steelCdpConnectionUrl,
  steelCdpUrl,
} from '../../providers/steel/session';
import {
  steelStartupProbe,
  validateBrowserConnection,
} from '../../providers/steel/sessionConnection';
import {
  assert,
  type BrowserApiResponse,
  isTransientKernelConnectionError,
  navigateKernelPage,
  retryBackendFetch,
} from './browser-provider.helpers';
import {
  deleteKernelProfile,
  runCrossProviderRotationLadderOrSkipOnSteelOutage,
} from './browser-provider-rotation.support';

const AGENT_LOCATION = { country: 'US', state: 'CA', city: 'San Francisco' } as const;

/** Create, validate, and release a Steel session that uses only Steel's defaults. */
async function steelDefaultSessionBoots(): Promise<boolean> {
  const session = await steel.sessions.create({});
  try {
    const validation = await validateBrowserConnection(steelCdpUrl(session.id), {
      startupProbe: steelStartupProbe(session.id, (id) => steel.sessions.retrieve(id)),
    });
    await validation.browser?.close().catch(() => {});
    console.warn(
      `[rotate_ip repro] Steel default control session ${session.id}: ${validation.failure ?? 'booted'}`
    );
    return validation.browser !== null;
  } finally {
    await releaseSteelRemoteSession(session.id).catch(() => {});
  }
}

export async function runLiveProviderParity(): Promise<void> {
  const baseUrl = process.env.TEST_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) return;
  const apiKey = process.env.BACKEND_API_KEY?.trim();
  const kernelApiKey = process.env.KERNEL_API_KEY?.trim();
  const steelApiKey = process.env.STEEL_API_KEY?.trim();
  const browserUseApiKey = process.env.BROWSER_USE_API_KEY?.trim() ?? '';
  const browserUseAvailable = browserUseEnabled();
  if (!apiKey || !kernelApiKey || !steelApiKey || (browserUseAvailable && !browserUseApiKey)) {
    throw new Error(
      'BACKEND_API_KEY, KERNEL_API_KEY, STEEL_API_KEY, and (when enabled) BROWSER_USE_API_KEY are required for live provider parity'
    );
  }

  const userId = `kernel-provider-${randomUUID()}`;
  const agentId = randomUUID();
  let liveSessionId: string | undefined;
  // Every provider session the cross-provider ladder allocates, so `finally` can
  // release the ones this scope never learned about (see its loop below).
  const allocatedSessionIds: string[] = [];
  let profileId: string | undefined;
  let proxyId: string | undefined;
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey };

  const invalidRotation = await retryBackendFetch(`${baseUrl}/api/browser-session/rotate-proxy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  assert(invalidRotation.status === 400, 'invalid rotate-proxy payload was not rejected');

  const post = async (path: string, body?: unknown): Promise<BrowserApiResponse> => {
    const response = await retryBackendFetch(`${baseUrl}/api/browser-session${path}`, {
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
  // Pin Kernel through the persisted preference so this parity still runs on
  // Kernel when the deployment default is Tilion (BROWSER_PROVIDER=tilion).
  await prisma.browserContext.create({
    data: {
      userId,
      preferredBrowserConfig: buildPreferredBrowserConfig(
        { provider: 'kernel', proxyMode: 'residential_city', kernelProxyType: 'residential' },
        AGENT_LOCATION
      ),
    },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'Validate Kernel browser provider parity',
      proxyCountry: AGENT_LOCATION.country,
      proxyState: AGENT_LOCATION.state,
      proxyCity: AGENT_LOCATION.city,
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
      const status = await navigateKernelPage(page, 'https://example.com');
      const title = await page.title();
      // Record what the residential exit actually served so a miss is diagnosable.
      assert(
        title === 'Example Domain',
        `Kernel CDP navigation failed: status=${status} title=${JSON.stringify(title)} url=${page.url()}`
      );
    } finally {
      await browser.close();
    }

    const kernel = new Kernel({ apiKey: kernelApiKey });
    const firstRemote = await kernel.browsers.retrieve(liveSessionId, { include_deleted: true });
    proxyId = firstRemote.proxy_id ?? undefined;
    assert(proxyId !== undefined, 'Kernel browser did not use the managed proxy');

    // ----- rotate_ip: real IP rotation on the same profile (residential tier) -----
    const readExitIp = async (wsUrl: string): Promise<string> => {
      // Production workers add the Steel key only at this process-local CDP
      // boundary. The live parity harness must exercise that same contract;
      // persisted/API ws_url values are deliberately secret-free.
      const b = await chromium.connectOverCDP(steelCdpConnectionUrl(wsUrl));
      try {
        const ctx = b.contexts()[0];
        const p = ctx.pages()[0] ?? (await ctx.newPage());
        await navigateKernelPage(
          p,
          `https://api.ipify.org?format=json&nonce=${encodeURIComponent(randomUUID())}`
        );
        const raw = await p.evaluate(() => document.body.innerText);
        // A rented exit node that is not serving yet answers with its own error page
        // (observed: a body starting "egress-pro…") instead of ipify's JSON. Report
        // that as a named transient carrying the real body: a bare JSON.parse throw
        // surfaces `Unexpected token 'e'`, which names neither the proxy nor the
        // response and is undiagnosable from a CI log.
        try {
          return String((JSON.parse(raw) as { ip?: string }).ip ?? '');
        } catch (error) {
          throw new Error(
            `exit-IP probe returned non-JSON body: ${raw
              .slice(0, 120)
              .replace(/\s+/g, ' ')} (${error instanceof Error ? error.message : String(error)})`
          );
        }
      } finally {
        await b.close();
      }
    };
    // Same transient tolerance as the post-rotation reads below. This baseline read
    // was the one unprotected call site, so a single not-ready exit node failed the
    // whole live-parity domain (seen twice under BLACKBOX_TEST_CONCURRENCY=4 while
    // the domain passed standalone).
    const readExitIpWithRetry = (wsUrl: string): Promise<string> =>
      retryWithBackoff(
        async () => {
          const ip = await readExitIp(wsUrl);
          if (ip === '') throw new Error('proxy returned an empty exit IP');
          return ip;
        },
        {
          maxRetries: 3,
          fixedDelays: [500, 1_000, 1_500],
          isRetryable: () => true,
          component: 'browser-provider:exit-ip-baseline',
        }
      );
    const readDifferentExitIp = (
      wsUrl: string,
      previousIp: string,
      stage: string
    ): Promise<string> =>
      retryWithBackoff(
        async () => {
          const ip = await readExitIp(wsUrl);
          if (ip === '' || ip === previousIp) {
            throw new Error(`proxy returned unchanged exit IP ${ip || '<empty>'} (${stage})`);
          }
          return ip;
        },
        {
          maxRetries: 3,
          fixedDelays: [500, 1_000, 1_500],
          // Kernel's residential/mobile proxy contract rotates exit nodes between
          // requests, so tolerate a provider returning the prior node once while
          // still requiring this session to demonstrate a genuinely different IP.
          isRetryable: () => true,
          component: 'browser-provider:exit-ip-change',
        }
      );

    const ipBefore = await readExitIpWithRetry(String(init.ws_url));

    const rotated = await postWithKernelConnectionRetry('/rotate-proxy', { task_id: init.task_id });
    assert(
      rotated.provider === 'kernel' && rotated.proxy_tier === 'residential',
      'first rotation must be Kernel residential'
    );
    assert(
      rotated.previous_provider === 'kernel' && rotated.recovery_action === 'ip_rotated',
      'first rotation returned incorrect recovery metadata'
    );
    assert(
      rotated.next_recovery === 'rotate_kernel_mobile_ip',
      'first rotation did not advertise mandatory Kernel mobile next'
    );
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

    const ipAfter = await readDifferentExitIp(
      String(rotated.ws_url),
      ipBefore,
      `rotation1 residential, Kernel session ${liveSessionId}`
    );
    // Residential exits vary per session; a rotation should land a different IP.
    assert(
      ipAfter !== '' && ipAfter !== ipBefore,
      `rotation did not change the exit IP (before=${ipBefore}, after=${ipAfter})`
    );

    // ----- call 2: mandatory Kernel mobile. No feature flag and no counter seeding:
    // this proves the real server-owned sequence that production will execute. -----
    const residentialIp = ipAfter;
    const mobileRotated = await postWithKernelConnectionRetry('/rotate-proxy', {
      task_id: init.task_id,
    });
    assert(
      mobileRotated.provider === 'kernel' && mobileRotated.proxy_tier === 'mobile',
      `call 2 expected Kernel mobile, got ${mobileRotated.provider}/${mobileRotated.proxy_tier}`
    );
    assert(
      mobileRotated.rotations_used === 2 && mobileRotated.rotations_remaining === 2,
      'call 2 returned the wrong rotation counters'
    );
    assert(
      mobileRotated.recovery_action === 'ip_rotated' &&
        mobileRotated.next_recovery === 'switch_provider_to_steel',
      'call 2 did not advertise the Kernel-to-Steel next recovery'
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
    const mobileRemote = await kernel.browsers.retrieve(liveSessionId, { include_deleted: true });
    const mobileProxyId = mobileRemote.proxy_id;
    assert(
      mobileProxyId !== undefined && mobileProxyId !== proxyId,
      'mobile rotation did not select a distinct managed proxy tier'
    );
    const mobileMetadata = mobileRotated.browser_session_metadata ?? {};
    const mobileIp = await readDifferentExitIp(
      String(mobileRotated.ws_url),
      residentialIp,
      `rotation2 mobile, Kernel session ${liveSessionId}`
    );
    // Ground truth comes from ipify, not from response metadata alone.
    assert(
      mobileIp !== '' && mobileIp !== residentialIp,
      `mobile rotation did not change the exit IP (residential=${residentialIp}, mobile=${mobileIp})`
    );
    // Print the ground-truth IP ladder so the run is a self-documenting repro of
    // the exit IP actually changing across tiers (baseline -> residential -> mobile).
    console.log(
      `[rotate_ip repro] exit IP ladder: baseline(res)=${ipBefore} ` +
        `-> rotation1(residential)=${ipAfter} ` +
        `-> rotation2(${mobileRotated.proxy_tier})=${mobileIp}`
    );

    // ----- unknown task → 404 -----
    const notFoundResponse = await retryBackendFetch(
      `${baseUrl}/api/browser-session/rotate-proxy`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ task_id: randomUUID() }),
      }
    );
    assert(
      notFoundResponse.status === 404,
      `expected 404 for an unknown task, got ${notFoundResponse.status}`
    );

    const taskResponse = await retryBackendFetch(
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
    const uploadResponse = await retryBackendFetch(
      `${baseUrl}/api/browser-session/${liveSessionId}/files`,
      {
        method: 'POST',
        headers: { 'x-api-key': apiKey },
        body: form,
      }
    );
    const upload = (await uploadResponse.json()) as BrowserApiResponse;
    assert(uploadResponse.ok && typeof upload.path === 'string', 'Kernel file upload failed');

    const listResponse = await retryBackendFetch(
      `${baseUrl}/api/browser-session/${liveSessionId}/files/list`,
      { headers: { 'x-api-key': apiKey } }
    );
    const listing = (await listResponse.json()) as { files?: Array<{ path: string }> };
    assert(
      listResponse.ok && listing.files?.some((file) => file.path === upload.path),
      'Kernel uploaded file was not listed'
    );

    const downloadResponse = await retryBackendFetch(
      `${baseUrl}/api/browser-session/${liveSessionId}/files/content?path=${encodeURIComponent(String(upload.path))}`,
      { headers: { 'x-api-key': apiKey } }
    );
    assert(
      downloadResponse.ok && (await downloadResponse.text()) === expectedContent,
      'Kernel file download did not round-trip'
    );

    const traversalResponse = await retryBackendFetch(
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
    const crossTenantFile = await retryBackendFetch(
      `${baseUrl}/api/browser-session/${liveSessionId}/files/content?path=${encodeURIComponent(String(upload.path))}`,
      { headers: { Authorization: `Bearer ${attackerToken}` } }
    );
    assert(crossTenantFile.status === 404, 'cross-tenant session file read was not rejected');
    const crossTenantScreenshot = await retryBackendFetch(
      `${baseUrl}/api/browser-session/${liveSessionId}/screenshot`,
      { method: 'POST', headers: { Authorization: `Bearer ${attackerToken}` } }
    );
    assert(crossTenantScreenshot.status === 404, 'cross-tenant screenshot was not rejected');
    const crossTenantRotation = await retryBackendFetch(
      `${baseUrl}/api/browser-session/rotate-proxy`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${attackerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ task_id: init.task_id }),
      }
    );
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
      resumedMetadata.proxy_source === mobileMetadata.proxy_source &&
        JSON.stringify(resumedMetadata.proxy_location) ===
          JSON.stringify(mobileMetadata.proxy_location),
      `resume lost the rotated proxy choice: before=${JSON.stringify(mobileMetadata)} after=${JSON.stringify(resumedMetadata)}`
    );

    const secondRemote = await kernel.browsers.retrieve(liveSessionId, { include_deleted: true });
    assert(secondRemote.proxy_id === mobileProxyId, 'resume did not reuse the rotated proxy ID');

    // Live parity exercises reuse of the shared proxy configuration. Deleting
    // and re-provisioning proxies belongs in the isolated stale-cache tests.
    console.log('[proxy reuse] resume retained the existing Kernel mobile proxy ID');

    // A Steel infra outage returns null (skips the Steel legs) while Kernel is
    // healthy; real rotation defects still throw. See the wrapper's doc comment.
    const crossProvider = await runCrossProviderRotationLadderOrSkipOnSteelOutage({
      baseUrl,
      headers,
      taskId: String(init.task_id),
      currentKernelSessionId: liveSessionId,
      mobileIp,
      post,
      readDifferentExitIp,
      readExitIp,
      retrieveKernelBrowser: (sessionId) =>
        kernel.browsers.retrieve(sessionId, { include_deleted: true }),
      retrieveSteelBrowser: (sessionId) => steel.sessions.retrieve(sessionId),
      retrieveBrowserUseBrowser: async (sessionId) => {
        const response = await fetch(`https://api.browser-use.com/api/v4/browsers/${sessionId}`, {
          headers: { 'X-Browser-Use-API-Key': browserUseApiKey },
        });
        assert(response.ok, `Browser Use session retrieve failed: HTTP ${response.status}`);
        return response.json() as Promise<{ status: string }>;
      },
      browserUseAvailable,
      steelControlSessionBoots: steelDefaultSessionBoots,
      allocatedSessionIds,
    });
    if (crossProvider === null) return;
    liveSessionId = crossProvider.finalSessionId;

    console.log(
      `[rotate_ip repro] complete ladder: kernel baseline=${ipBefore} residential=${ipAfter} mobile=${mobileIp}; steel=${crossProvider.firstSteelIp}` +
        (crossProvider.browserUseIp === null
          ? '; Browser Use disabled, final provider=Steel'
          : `; browser-use=${crossProvider.browserUseIp}`)
    );

    await post('/close', { session_id: liveSessionId, pause: false });
    liveSessionId = undefined;
  } finally {
    if (liveSessionId) {
      await post('/close', { session_id: liveSessionId, pause: false }).catch(() => {});
    }
    // Release every session the ladder allocated, not just the one this scope
    // happens to hold. `liveSessionId` is only advanced to the ladder's final id on
    // the SUCCESS path, so a mid-ladder throw (Steel 429 on call 4) otherwise leaves
    // a live, billing Steel session behind with its DB row already deleted below.
    // Closing an already-closed session is a no-op, so this is safe to repeat.
    for (const sessionId of allocatedSessionIds) {
      if (sessionId === liveSessionId) continue;
      await post('/close', { session_id: sessionId, pause: false }).catch(() => {});
    }
    if (profileId) await deleteKernelProfile(profileId).catch(() => {});
    const browserUseProfiles = await prisma.browserProviderProfile.findMany({
      where: { provider: 'browser-use', context: { userId } },
      select: { profileId: true },
    });
    for (const profile of browserUseProfiles) {
      await fetch(`https://api.browser-use.com/api/v4/profiles/${profile.profileId}`, {
        method: 'DELETE',
        headers: { 'X-Browser-Use-API-Key': browserUseApiKey },
      }).catch(() => {});
    }
    await prisma.browserSession.deleteMany({ where: { agentId } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}
