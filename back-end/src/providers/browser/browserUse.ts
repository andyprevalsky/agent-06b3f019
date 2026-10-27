export { browserUseProxyCountry } from './resumeRecovery';
import * as resumeRecovery from './resumeRecovery';
import { browserResumeScope } from '../steel/lifecycleClaim';
/** Browser Use Cloud V4 sessions, exposed through the same CDP contract as Steel and Kernel. */
import { createHash, randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import { request } from './browserUseClient';
import { retryWithBackoff } from '../retry';
import { connectValidatedBrowser } from '../steel/sessionConnection';
import { benchmarkIsolatedBrowserProfilesEnabled } from './benchmarkProfileIsolation';
import { getProviderProfile, rememberProviderProfile } from './context';
import { persistBrowserSessionRow } from './sessionPersist';
import { announceBrowserSessionBinding } from './sessionBindingAnnounce';
import {
  storedBrowserProvider,
  type BrowserProviderName,
  type BrowserProviderResumeSession,
  type BrowserProviderSession,
  type BrowserSessionHealth,
  type BrowserFileInfo,
} from './types';
import { captureContextStorage } from './contextStorageCapture';

const log = createLogger('BrowserUse');
const profileCreationByContext = new Map<string, Promise<{ id: string; source: string }>>();
const benchmarkProfilesByAgent = new Map<string, Promise<string>>();
const initialStorageHashes = new Map<string, string>();

type BrowserUseProfile = { updatedAt: string };

async function storageHash(browser: Browser): Promise<string> {
  const context = browser.contexts()[0];
  if (!context) throw new Error('Browser Use session has no CDP context');
  // A fresh client only sees origins it watched navigate; the agent drove this
  // session, so read every open page/frame origin (localStorage + IndexedDB).
  const state = await captureContextStorage(context);
  const cookies = [...state.cookies].sort((a, b) =>
    `${a.domain}/${a.path}/${a.name}`.localeCompare(`${b.domain}/${b.path}/${b.name}`)
  );
  const origins = [...state.origins]
    .map((origin) => ({
      ...origin,
      localStorage: [...origin.localStorage].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.origin.localeCompare(b.origin));
  return createHash('sha256').update(JSON.stringify({ cookies, origins })).digest('hex');
}

async function rememberInitialStorage(sessionId: string, browser: Browser): Promise<void> {
  try {
    initialStorageHashes.set(sessionId, await storageHash(browser));
  } catch (error) {
    log.warn('Could not snapshot initial Browser Use storage', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function waitForProfileSave(profileId: string, before: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  do {
    const profile = await request<BrowserUseProfile>(`/profiles/${encodeURIComponent(profileId)}`);
    if (profile.updatedAt !== before) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error('Browser Use profile did not finish saving browser state after stop');
}

async function profileForContext(
  contextId: string,
  agentId: string
): Promise<{ id: string; source: string }> {
  if (benchmarkIsolatedBrowserProfilesEnabled()) {
    const existing = benchmarkProfilesByAgent.get(agentId);
    if (existing) return { id: await existing, source: 'user_persistent' };
    const pending = request<{ id: string }>('/profiles', {
      method: 'POST',
      body: JSON.stringify({ userId: `benchmark:${agentId}` }),
    }).then((profile) => profile.id);
    benchmarkProfilesByAgent.set(agentId, pending);
    try {
      return { id: await pending, source: 'new_user_persistent' };
    } catch (error) {
      if (benchmarkProfilesByAgent.get(agentId) === pending)
        benchmarkProfilesByAgent.delete(agentId);
      throw error;
    }
  }
  const pending = profileCreationByContext.get(contextId);
  if (pending) return pending;
  const creating = createUserProfile(contextId);
  profileCreationByContext.set(contextId, creating);
  try {
    return await creating;
  } finally {
    if (profileCreationByContext.get(contextId) === creating)
      profileCreationByContext.delete(contextId);
  }
}

async function createUserProfile(contextId: string): Promise<{ id: string; source: string }> {
  const existing = await getProviderProfile(contextId, 'browser-use');
  if (existing) return { id: existing, source: 'user_persistent' };
  const context = await prisma.browserContext.findUniqueOrThrow({
    where: { id: contextId },
  });
  const created = await request<{ id: string }>('/profiles', {
    method: 'POST',
    body: JSON.stringify({ userId: context.userId }),
  });
  try {
    await rememberProviderProfile(contextId, 'browser-use', created.id);
  } catch (error) {
    await request(`/profiles/${encodeURIComponent(created.id)}`, {
      method: 'DELETE',
    }).catch(() => {});
    throw error;
  }
  return { id: created.id, source: 'new_user_persistent' };
}

export async function cleanupBenchmarkBrowserUseProfiles(): Promise<void> {
  const profiles = [...benchmarkProfilesByAgent.values()];
  benchmarkProfilesByAgent.clear();
  const results = await Promise.allSettled(
    profiles.map(async (pending) => {
      const id = await pending;
      await request(`/profiles/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    })
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      log.warn('Failed to delete isolated Browser Use profile', {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}

async function createRemote(
  location: ProxyGeoLocation,
  profileId: string | null
): Promise<{ session: resumeRecovery.BrowserUseSession; browser: Browser }> {
  const session = await resumeRecovery.allocateBrowserUseSession(location, profileId);
  try {
    if (!session.id || !session.cdpUrl || !session.liveUrl) {
      throw new Error('Browser Use create response omitted id, cdpUrl, or liveUrl');
    }
    const browser = await connectValidatedBrowser(session.cdpUrl);
    if (!browser) throw new Error('Browser Use CDP validation failed');
    return { session, browser };
  } catch (error) {
    if (session.id) {
      try {
        await releaseBrowserUseRemoteSession(session.id);
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          `Browser Use session ${session.id} failed validation and cleanup`
        );
      }
    }
    throw error;
  }
}

export async function releaseBrowserUseRemoteSession(sessionId: string): Promise<void> {
  try {
    await retryWithBackoff(
      () =>
        request<resumeRecovery.BrowserUseSession>(`/browsers/${encodeURIComponent(sessionId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ action: 'stop' }),
        }),
      {
        maxRetries: 3,
        fixedDelays: [250, 500],
        isRetryable: (error) =>
          !(error instanceof Error && /^Browser Use HTTP 4(?!29)/.test(error.message)),
        component: 'Browser Use session stop',
      }
    );
    initialStorageHashes.delete(sessionId);
  } catch (error) {
    // A previously paused or expired browser can already be gone.
    if (error instanceof Error && error.message.startsWith('Browser Use HTTP 404:')) {
      initialStorageHashes.delete(sessionId);
      return;
    }
    throw error;
  }
}

export async function createBrowserUseSessionWithContext(
  contextId: string,
  agentId: string,
  location: ProxyGeoLocation = DEFAULT_GEOLOCATION,
  startUrl?: string,
  options?: { keepValidationConnection?: boolean; taskId?: string }
): Promise<BrowserProviderSession> {
  const profile = await profileForContext(contextId, agentId);
  const remote = await createRemote(location, profile.id);
  const { session, browser } = remote;
  try {
    const row = await persistBrowserSessionRow({
      taskId: options?.taskId,
      contextId,
      agentId,
      sessionId: session.id,
      debugUrl: session.liveUrl,
      wsUrl: session.cdpUrl,
      startUrl,
      provider: 'browser-use',
      providerProfileId: profile.id,
      providerProfileSource: profile.source,
      releaseRemoteSession: releaseBrowserUseRemoteSession,
    });
    await rememberInitialStorage(session.id, browser);
    if (!options?.keepValidationConnection) await browser.close().catch(() => {});
    return {
      provider: 'browser-use',
      sessionId: session.id,
      debugUrl: session.liveUrl!,
      taskId: row.id,
      wsUrl: session.cdpUrl!,
      proxySource: 'browser_use_residential_country',
      proxyLocation: { country: location.country },
      profileId: profile.id,
      profileSource: profile.source,
      validationBrowser: options?.keepValidationConnection ? browser : null,
    };
  } catch (error) {
    await Promise.allSettled([browser.close(), releaseBrowserUseRemoteSession(session.id)]);
    throw error;
  }
}

/** Profile-free candidate used by challenge recovery before atomic promotion. */
export async function createBrowserUseRecoverySession(location: ProxyGeoLocation) {
  const { session, browser } = await createRemote(location, null);
  return {
    sessionId: session.id,
    debugUrl: session.liveUrl!,
    wsUrl: session.cdpUrl!,
    proxySource: 'browser_use_residential_country',
    proxyLocation: { country: location.country },
    profileId: null,
    profileSource: 'challenge_candidate_ephemeral',
    validationBrowser: browser,
  };
}

export async function closeBrowserUseSession(
  sessionId: string,
  pause = false,
  currentUrl?: string
): Promise<void> {
  const row = await prisma.browserSession.findUnique({
    where: { sessionId },
    select: { providerProfileId: true, wsUrl: true },
  });
  const initialHash = initialStorageHashes.get(sessionId);
  let profileBefore: string | null = null;
  let unknownBaseline = false;
  let checkpointConfirmed = false;
  if (row?.providerProfileId && row.wsUrl) {
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.connectOverCDP(row.wsUrl);
      try {
        const currentHash = await storageHash(browser);
        unknownBaseline = initialHash === undefined;
        checkpointConfirmed = !unknownBaseline && currentHash === initialHash;
        if (unknownBaseline || currentHash !== initialHash) {
          const profile = await request<BrowserUseProfile>(
            `/profiles/${encodeURIComponent(row.providerProfileId)}`
          );
          profileBefore = profile.updatedAt;
        }
      } finally {
        await browser.close().catch(() => {});
      }
    } catch (error) {
      // An expired browser cannot be inspected. The remote provider may have
      // already saved it; retain a bounded grace period after stop.
      unknownBaseline = true;
      log.warn('Could not inspect Browser Use storage before stop', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // A grace period is not evidence that a profile was saved. If inspection
  // failed, obtain a pre-stop version so pause can verify the provider save.
  // Refuse to release a live browser when no checkpoint can be established.
  if (pause && !checkpointConfirmed && !profileBefore) {
    if (!row?.providerProfileId) {
      throw new Error('Cannot pause Browser Use session without a persistent profile');
    }
    const profile = await request<BrowserUseProfile>(
      `/profiles/${encodeURIComponent(row.providerProfileId)}`
    );
    profileBefore = profile.updatedAt;
    if (!profileBefore) throw new Error('Cannot verify Browser Use profile before pause');
  }
  let releaseError: unknown = null;
  let stopped = false;
  try {
    await releaseBrowserUseRemoteSession(sessionId);
    stopped = true;
  } catch (error) {
    releaseError = error;
  }
  if (stopped && row?.providerProfileId && (profileBefore || unknownBaseline)) {
    try {
      if (profileBefore) {
        await waitForProfileSave(row.providerProfileId, profileBefore);
        checkpointConfirmed = true;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    } catch (error) {
      if (pause || !unknownBaseline) releaseError = error;
      else
        log.warn('Browser Use profile save could not be confirmed after stop', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  }
  if (stopped) initialStorageHashes.delete(sessionId);
  await prisma.browserSession.update({
    where: { sessionId },
    data: {
      status: stopped
        ? pause
          ? checkpointConfirmed && releaseError === null
            ? 'PAUSED'
            : 'ERROR'
          : 'CLOSED'
        : pause
          ? 'ACTIVE'
          : 'ERROR',
      closedAt: stopped && !pause ? new Date() : null,
      currentUrl: currentUrl || undefined,
    },
  });
  await announceBrowserSessionBinding({ sessionId });
  if (releaseError) throw releaseError;
}

async function replaceSession(
  taskId: string,
  options: { keepValidationConnection?: boolean } = {}
): Promise<
  BrowserProviderResumeSession & {
    previousSessionId: string | null;
    previousProvider: BrowserProviderName;
  }
> {
  const old = await prisma.browserSession.findUniqueOrThrow({
    where: { id: taskId },
  });
  // Browser Use writes persistent profile state asynchronously after stop.
  // Reusing the profile while the old browser is still active loses fresh login state.
  if (
    old.provider === 'browser-use' &&
    old.status === 'ACTIVE' &&
    old.sessionId !== null &&
    !browserResumeScope()?.recovering() &&
    !browserResumeScope()?.sourceEnded()
  ) {
    await closeBrowserUseSession(old.sessionId, true, old.currentUrl ?? undefined);
  }
  const agent = await prisma.agent.findUnique({
    where: { id: old.agentId },
    select: { proxyCountry: true, proxyState: true, proxyCity: true },
  });
  const location: ProxyGeoLocation = agent?.proxyCountry
    ? {
        country: agent.proxyCountry,
        ...(agent.proxyState ? { state: agent.proxyState } : {}),
        ...(agent.proxyCity ? { city: agent.proxyCity } : {}),
      }
    : DEFAULT_GEOLOCATION;
  const profile = old.logicalOwnerKey
    ? { id: null, source: 'logical_checkpoint' }
    : await profileForContext(old.contextId, old.agentId);
  const { session, browser } = await createRemote(location, profile.id);
  let handedOff = false;
  try {
    await rememberInitialStorage(session.id, browser);
    await browserResumeScope()?.assertOwned();
    const replaced = await prisma.browserSession.updateMany({
      where: resumeRecovery.replacementBinding(taskId, old),
      data: {
        sessionId: session.id,
        debugUrl: session.liveUrl,
        wsUrl: session.cdpUrl,
        status: old.logicalOwnerKey ? 'PAUSED' : 'ACTIVE',
        closedAt: null,
        provider: 'browser-use',
        providerProfileId: profile.id,
        providerProfileSource: profile.source,
        providerProfilePersist: true,
        proxyTier: 'residential',
      },
    });
    if (replaced.count !== 1) throw new Error(`Browser task ${taskId} changed during replacement`);
    await announceBrowserSessionBinding({ id: taskId });
    const savedUrl = old.currentUrl || old.startUrl || undefined;
    if (savedUrl && !old.logicalOwnerKey) {
      try {
        const context = browser.contexts()[0];
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(savedUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 10_000,
        });
      } catch (error) {
        // The replacement row is already committed; the worker can retry
        // navigation after attaching to the returned CDP URL.
        log.warn('Browser Use replacement could not restore saved URL', {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    handedOff = true;
    return {
      ...(options.keepValidationConnection ? { validationBrowser: browser } : {}),
      provider: 'browser-use',
      debugUrl: session.liveUrl!,
      sessionId: session.id,
      wsUrl: session.cdpUrl!,
      savedUrl,
      proxySource: 'browser_use_residential_country',
      proxyLocation: { country: location.country },
      profileId: profile.id,
      profileSource: profile.source,
      previousSessionId: old.sessionId,
      // Released through this provider: keep Tilion/Kernel/Steel predecessors' own name.
      previousProvider: storedBrowserProvider(old.provider),
    };
  } catch (error) {
    await releaseBrowserUseRemoteSession(session.id).catch(() => {});
    throw error;
  } finally {
    if (!options.keepValidationConnection || !handedOff) await browser.close().catch(() => {});
  }
}

export const resumeBrowserUseSession = replaceSession;
export const rotateBrowserUseSession = replaceSession;

export async function getBrowserUseSessionHealth(sessionId: string): Promise<BrowserSessionHealth> {
  const session = await request<resumeRecovery.BrowserUseSession>(
    `/browsers/${encodeURIComponent(sessionId)}`
  );
  const expiresAt = new Date(session.timeoutAt).getTime();
  const createdAt = new Date(session.startedAt).getTime();
  return {
    provider: 'browser-use',
    sessionId,
    status: session.status,
    createdAt: session.startedAt,
    expiresAt: session.timeoutAt,
    timeoutMs: expiresAt - createdAt,
    ttlMs: Math.max(0, expiresAt - Date.now()),
    profileId: null,
  };
}

/** Send the same browser-process keyboard chords offered by the Kernel route. */
export async function pressBrowserUseKeys(sessionId: string, keys: string[]): Promise<void> {
  const row = await prisma.browserSession.findUniqueOrThrow({
    where: { sessionId },
    select: { provider: true, wsUrl: true },
  });
  if (row.provider !== 'browser-use' || !row.wsUrl) {
    throw new Error(`Browser Use CDP URL unavailable for session ${sessionId}`);
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(row.wsUrl);
  try {
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error('Browser Use session has no page for keyboard input');
    await page.keyboard.press(keys.join('+'));
  } finally {
    await browser.close().catch(() => {});
  }
}

type Download = BrowserFileInfo & { url?: string | null; lastModified: string };
type DownloadPage = { files: Download[]; hasMore: boolean; nextCursor: string | null };

export async function listBrowserUseSessionFiles(sessionId: string): Promise<BrowserFileInfo[]> {
  const files: BrowserFileInfo[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const page = await request<DownloadPage>(
      `/browsers/${encodeURIComponent(sessionId)}/downloads?${params}`
    );
    files.push(
      ...page.files.map(({ path, size, lastModified }) => ({
        path,
        size,
        lastModified,
      }))
    );
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
  return files;
}

export async function readBrowserUseSessionFile(sessionId: string, path: string): Promise<Buffer> {
  const params = new URLSearchParams({ includeUrls: 'true', limit: '100' });
  let cursor: string | null = null;
  do {
    if (cursor) params.set('cursor', cursor);
    const page = await request<DownloadPage>(
      `/browsers/${encodeURIComponent(sessionId)}/downloads?${params}`
    );
    const found = page.files.find((file) => file.path === path);
    if (found) {
      if (!found.url) throw new Error(`Browser Use download URL unavailable: ${path}`);
      const response = await fetch(found.url, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Browser Use download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    }
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
  throw new Error(`Browser Use download not found: ${path}`);
}

/** Deliver bytes to the browser's Downloads directory for screenshot and input-file flows. */
export async function uploadBrowserUseSessionFile(
  sessionId: string,
  content: Buffer,
  filename: string,
  mimeType: string,
  options: { directory?: string } = {}
): Promise<{ path: string; size: number }> {
  if (options.directory && options.directory !== '/tmp/downloads') {
    throw new Error(`Browser Use cannot upload into ${options.directory}`);
  }
  if (!filename || filename === '.' || filename === '..' || /[/\\\0]/.test(filename)) {
    throw new Error('Browser Use upload requires a plain filename');
  }
  const row = await prisma.browserSession.findUniqueOrThrow({
    where: { sessionId },
    select: { provider: true, wsUrl: true },
  });
  if (row.provider !== 'browser-use' || !row.wsUrl) {
    throw new Error(`Browser Use CDP URL unavailable for session ${sessionId}`);
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(row.wsUrl);
  let page: Awaited<ReturnType<Browser['newPage']>> | undefined;
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Browser Use session has no CDP context');
    page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: '/tmp/downloads',
      eventsEnabled: true,
    });
    await page.goto('https://example.com', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    // Chrome may auto-rename a repeated download. Give this upload a unique
    // remote filename so verification can only read the bytes just written.
    const dot = filename.lastIndexOf('.');
    const suffix = randomUUID();
    const downloadName =
      dot > 0
        ? `${filename.slice(0, dot)}-${suffix}${filename.slice(dot)}`
        : `${filename}-${suffix}`;
    const expression = `(() => {
      const binary = atob(${JSON.stringify(content.toString('base64'))});
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: ${JSON.stringify(mimeType)} }));
      const link = document.createElement('a');
      link.href = url;
      link.download = ${JSON.stringify(downloadName)};
      document.documentElement.appendChild(link);
      link.click();
      link.remove();
    })()`;
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      page.evaluate(expression),
    ]);
    const failure = await download.failure();
    if (failure) throw new Error(`Browser Use upload download failed: ${failure}`);
    const path = `/tmp/downloads/${download.suggestedFilename()}`;
    await page.evaluate(
      'document.documentElement.insertAdjacentHTML(\'beforeend\', \'<input type="file" id="browser-use-upload-check">\')'
    );
    const document = await cdp.send('DOM.getDocument');
    const input = await cdp.send('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: '#browser-use-upload-check',
    });
    if (!input.nodeId) throw new Error('Browser Use upload verification input unavailable');
    await cdp.send('DOM.setFileInputFiles', {
      nodeId: input.nodeId,
      files: [path],
    });
    const uploaded = await page.evaluate(`new Promise((resolve, reject) => {
      const file = document.querySelector('#browser-use-upload-check').files[0];
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    })`);
    const encoded = String(uploaded).split(',')[1];
    if (!encoded || !Buffer.from(encoded, 'base64').equals(content)) {
      throw new Error(`Browser Use remote file verification failed for ${filename}`);
    }
    return { path, size: content.length };
  } finally {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
