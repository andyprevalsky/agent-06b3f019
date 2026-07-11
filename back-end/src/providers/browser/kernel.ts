import path from 'node:path';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import Kernel, { PermissionDeniedError, RateLimitError } from '@onkernel/sdk';
import type { Browser } from 'playwright';
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import { retryWithBackoff } from '../retry';
import { connectValidatedBrowser, validateSessionConnection } from '../steel/sessionConnection';
import { browserProviderEnabled } from './config';
import { getProviderProfile, rememberProviderProfile } from './context';
import {
  getOrCreateKernelProxy,
  isKernelProxyAvailabilityError,
  kernelProxyCandidates,
  resolveKernelProxyMode,
  type ResolvedKernelProxy,
} from './kernelProxy';
import {
  BrowserProviderRateLimitError,
  type BrowserFileInfo,
  type BrowserProviderResumeSession,
  type BrowserProviderSession,
  type BrowserSessionHealth,
} from './types';

const log = createLogger('Kernel');

class KernelSessionValidationError extends Error {}

type KernelProxySelection = {
  proxyId?: string;
  proxyKey?: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
};

function kernelClient(): Kernel {
  const apiKey = process.env.KERNEL_API_KEY?.trim();
  if (!apiKey) throw new Error('KERNEL_API_KEY is required when BROWSER_PROVIDER=kernel');
  return new Kernel({ apiKey });
}

function readOnlyLiveView(url: string | undefined): string {
  if (!url) return '';
  const parsed = new URL(url);
  parsed.searchParams.set('readOnly', 'true');
  return parsed.toString();
}

function kernelTimeoutSeconds(): number {
  const parsed = Number.parseInt(process.env.KERNEL_TIMEOUT_SECONDS ?? '900', 10);
  return Number.isFinite(parsed) ? Math.min(259_200, Math.max(10, parsed)) : 900;
}

async function deleteKernelBrowser(sessionId: string): Promise<void> {
  await retryWithBackoff(
    async () => {
      const apiKey = process.env.KERNEL_API_KEY?.trim();
      if (!apiKey) throw new Error('KERNEL_API_KEY is required to delete Kernel sessions');
      const baseUrl = (process.env.KERNEL_API_BASE_URL ?? 'https://api.onkernel.com').replace(
        /\/$/,
        ''
      );
      const url = new URL(`${baseUrl}/browsers/${encodeURIComponent(sessionId)}`);
      const statusCode = await new Promise<number>((resolve, reject) => {
        const request = https.request(
          url,
          { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode ?? 0));
          }
        );
        request.setTimeout(10_000, () => {
          request.destroy(new Error('Kernel session delete timed out'));
        });
        request.once('error', reject);
        request.end();
      });
      if (statusCode !== 204 && statusCode !== 404) {
        throw new Error(`Kernel session delete failed: HTTP ${statusCode}`);
      }
    },
    {
      maxRetries: 3,
      fixedDelays: [250, 500],
      isRetryable: () => true,
      component: 'Kernel session delete',
    }
  );
}

async function createProfile(contextId: string): Promise<{
  profileId: string | null;
  profileSource: string;
}> {
  if (!browserProviderEnabled('KERNEL_PROFILE_ENABLED', true)) {
    return { profileId: null, profileSource: 'disabled' };
  }
  const existing = await getProviderProfile(contextId, 'kernel');
  if (existing !== null) {
    return { profileId: existing, profileSource: 'user_persistent' };
  }

  const client = kernelClient();
  let profile;
  try {
    profile = await client.profiles.create({});
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      const message = `Kernel profiles are required but unavailable: ${error.message}`;
      if (browserProviderEnabled('KERNEL_PROFILE_REQUIRED', true)) {
        throw new Error(message, { cause: error });
      }
      log.warn(`${message}; using an ephemeral browser`);
      return { profileId: null, profileSource: 'unavailable_plan' };
    }
    throw error;
  }
  try {
    await rememberProviderProfile(contextId, 'kernel', profile.id);
    return { profileId: profile.id, profileSource: 'new_user_persistent' };
  } catch (error) {
    const winner = await getProviderProfile(contextId, 'kernel');
    if (winner !== null) {
      await client.profiles.delete(profile.id).catch(() => {});
      return { profileId: winner, profileSource: 'user_persistent' };
    }
    throw error;
  }
}

async function createRemoteSession(
  contextId: string,
  agentId: string,
  proxyLocation: ProxyGeoLocation
): Promise<{
  sessionId: string;
  debugUrl: string;
  wsUrl: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  profileId: string | null;
  profileSource: string;
  validationBrowser: Browser;
}> {
  const client = kernelClient();
  const profile = await createProfile(contextId);
  const stealth = browserProviderEnabled('KERNEL_STEALTH_ENABLED', true);

  const createValidatedSession = async (proxy: KernelProxySelection) =>
    retryWithBackoff(
      async () => {
        const session = await client.browsers.create({
          headless: browserProviderEnabled('KERNEL_HEADLESS_ENABLED', false),
          stealth,
          gpu: browserProviderEnabled('KERNEL_GPU_ENABLED', false),
          timeout_seconds: kernelTimeoutSeconds(),
          viewport: { width: 1280, height: 800, refresh_rate: 60 },
          ...(profile.profileId !== null
            ? { profile: { id: profile.profileId, save_changes: true } }
            : {}),
          ...(proxy.proxyId !== undefined ? { proxy_id: proxy.proxyId } : {}),
          tags: { rose_agent_id: agentId, rose_session_request: randomUUID() },
        });

        const validationBrowser = await connectValidatedBrowser(session.cdp_ws_url);
        if (validationBrowser !== null) {
          return {
            sessionId: session.session_id,
            debugUrl: readOnlyLiveView(session.browser_live_view_url),
            wsUrl: session.cdp_ws_url,
            proxySource: proxy.proxySource,
            proxyLocation: proxy.proxyLocation,
            profileId: session.profile?.id ?? profile.profileId,
            profileSource: profile.profileSource,
            validationBrowser,
          };
        }

        await deleteKernelBrowser(session.session_id).catch((error) => {
          log.warn('Failed to evict invalid Kernel session', {
            sessionId: session.session_id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        throw new KernelSessionValidationError(
          `Kernel session ${session.session_id} failed CDP validation`
        );
      },
      {
        maxRetries: 3,
        fixedDelays: [250, 500],
        isRetryable: (error) => error instanceof KernelSessionValidationError,
        component: 'Kernel CDP validation',
      }
    );

  const createWithManagedProxy = async (
    candidates: ReturnType<typeof kernelProxyCandidates>,
    index: number
  ): ReturnType<typeof createValidatedSession> => {
    const candidate = candidates[index];
    if (candidate === undefined) {
      throw new Error(`Kernel has no available residential proxy for ${proxyLocation.country}`);
    }

    let resolved: ResolvedKernelProxy | undefined;
    try {
      resolved = await getOrCreateKernelProxy(client, candidate);
      return await createValidatedSession({
        proxyId: resolved.proxyId,
        proxyKey: resolved.proxyKey,
        proxySource: resolved.source,
        proxyLocation: resolved.location,
      });
    } catch (error) {
      if (!isKernelProxyAvailabilityError(error) || index + 1 >= candidates.length) throw error;

      log.warn('Kernel proxy location unavailable; relaxing location specificity', {
        proxyKey: candidate.proxyKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return createWithManagedProxy(candidates, index + 1);
    }
  };

  try {
    const proxyMode = resolveKernelProxyMode();
    if (proxyMode.kind === 'explicit') {
      return await createValidatedSession({
        proxyId: proxyMode.proxyId,
        proxySource: 'kernel_configured',
        proxyLocation,
      });
    }
    if (!browserProviderEnabled('KERNEL_PROXY_ENABLED', true)) {
      return await createValidatedSession({
        proxySource: stealth ? 'kernel_stealth' : 'none',
        proxyLocation,
      });
    }
    return await createWithManagedProxy(kernelProxyCandidates(proxyLocation), 0);
  } catch (error) {
    if (error instanceof RateLimitError) {
      throw new BrowserProviderRateLimitError('kernel', error.message);
    }
    throw error;
  }
}

export async function createKernelSessionWithContext(
  contextId: string,
  agentId: string,
  proxyLocation: ProxyGeoLocation = DEFAULT_GEOLOCATION,
  _startUrl?: string,
  options?: { keepValidationConnection?: boolean }
): Promise<BrowserProviderSession> {
  const remote = await createRemoteSession(contextId, agentId, proxyLocation);
  let dbSession;
  try {
    dbSession = await prisma.browserSession.create({
      data: {
        contextId,
        agentId,
        sessionId: remote.sessionId,
        debugUrl: remote.debugUrl,
        wsUrl: remote.wsUrl,
        status: 'ACTIVE',
        startUrl: _startUrl || undefined,
        provider: 'kernel',
      },
    });
  } catch (error) {
    await Promise.allSettled([
      deleteKernelBrowser(remote.sessionId),
      remote.validationBrowser.close(),
    ]);
    throw error;
  }

  let validationBrowser: Browser | null = remote.validationBrowser;
  if (!options?.keepValidationConnection) {
    await validationBrowser.close().catch(() => {});
    validationBrowser = null;
  }

  log.info('Created Kernel browser session', {
    sessionId: remote.sessionId,
    contextId,
    profileId: remote.profileId,
  });

  return {
    provider: 'kernel',
    taskId: dbSession.id,
    ...remote,
    validationBrowser,
  };
}

export async function closeKernelSession(
  sessionId: string,
  pause = false,
  currentUrl?: string
): Promise<void> {
  try {
    await deleteKernelBrowser(sessionId);
  } catch (error) {
    log.warn('Failed to delete Kernel session; finalizing local session state', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await prisma.browserSession.update({
    where: { sessionId },
    data: {
      status: pause ? 'PAUSED' : 'CLOSED',
      closedAt: pause ? undefined : new Date(),
      currentUrl: currentUrl || undefined,
    },
  });
}

export async function resumeKernelSession(taskId: string): Promise<BrowserProviderResumeSession> {
  const oldSession = await prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { context: true },
  });
  if (oldSession === null) throw new Error(`Browser task not found: ${taskId}`);

  const agent = await prisma.agent.findUnique({
    where: { id: oldSession.agentId },
    select: { proxyCountry: true, proxyState: true, proxyCity: true },
  });
  const proxyLocation: ProxyGeoLocation = agent?.proxyCountry
    ? {
        country: agent.proxyCountry,
        ...(agent.proxyState ? { state: agent.proxyState } : {}),
        ...(agent.proxyCity ? { city: agent.proxyCity } : {}),
      }
    : DEFAULT_GEOLOCATION;

  const remote = await createRemoteSession(oldSession.contextId, oldSession.agentId, proxyLocation);
  await remote.validationBrowser.close().catch(() => {});

  await prisma.browserSession.update({
    where: { id: taskId },
    data: {
      sessionId: remote.sessionId,
      debugUrl: remote.debugUrl,
      wsUrl: remote.wsUrl,
      status: 'ACTIVE',
      closedAt: null,
      provider: 'kernel',
    },
  });

  const savedUrl = oldSession.currentUrl || oldSession.startUrl || undefined;
  if (savedUrl && (await validateSessionConnection(remote.wsUrl))) {
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(remote.wsUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
    await browser.close().catch(() => {});
  }

  return {
    provider: 'kernel',
    debugUrl: remote.debugUrl,
    sessionId: remote.sessionId,
    wsUrl: remote.wsUrl,
    savedUrl,
    proxySource: remote.proxySource,
    proxyLocation: remote.proxyLocation,
    profileId: remote.profileId,
    profileSource: remote.profileSource,
  };
}

export async function getKernelSessionHealth(sessionId: string): Promise<BrowserSessionHealth> {
  const session = await kernelClient().browsers.retrieve(sessionId, { include_deleted: true });
  return {
    provider: 'kernel',
    sessionId,
    status: session.deleted_at ? 'deleted' : 'active',
    createdAt: session.created_at,
    timeoutMs: session.timeout_seconds * 1000,
    expiresAt: null,
    ttlMs: null,
    profileId: session.profile?.id ?? null,
    uptimeMs: session.usage?.uptime_ms ?? null,
  };
}

const FILE_DIRECTORIES = ['/tmp/downloads', '/tmp/rose-uploads', '/home/oai/share'];

export async function listKernelSessionFiles(sessionId: string): Promise<BrowserFileInfo[]> {
  const client = kernelClient();
  const results = await Promise.all(
    FILE_DIRECTORIES.map(async (directory) => {
      try {
        return await client.browsers.fs.listFiles(sessionId, { path: directory });
      } catch {
        return [];
      }
    })
  );
  const byPath = new Map<string, BrowserFileInfo>();
  for (const file of results.flat()) {
    if (!file.is_dir) {
      byPath.set(file.path, {
        path: file.path,
        size: file.size_bytes,
        lastModified: file.mod_time,
      });
    }
  }
  return [...byPath.values()];
}

export async function uploadKernelSessionFile(
  sessionId: string,
  fileBuffer: Buffer,
  filename: string
): Promise<{ path: string; size: number }> {
  const client = kernelClient();
  const directory = '/tmp/rose-uploads';
  await client.browsers.fs.createDirectory(sessionId, { path: directory }).catch(() => {});
  const remotePath = `${directory}/${path.basename(filename)}`;
  await client.browsers.fs.writeFile(sessionId, fileBuffer, { path: remotePath });
  return { path: remotePath, size: fileBuffer.length };
}

export async function readKernelSessionFile(sessionId: string, filePath: string): Promise<Buffer> {
  const response = await kernelClient().browsers.fs.readFile(sessionId, { path: filePath });
  return Buffer.from(await response.arrayBuffer());
}

export async function captureKernelScreenshot(sessionId: string): Promise<Buffer> {
  const response = await kernelClient().browsers.computer.captureScreenshot(sessionId);
  return Buffer.from(await response.arrayBuffer());
}
