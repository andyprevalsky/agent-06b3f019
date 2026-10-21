/**
 * Tilion Cloud browser sessions, exposed through the same CDP contract as
 * Steel, Kernel and Browser Use. See docs/plans/active/tilion-browser-provider.md.
 *
 * create:  POST /v1/session (residential, geo city→state→country, Idempotency-Key)
 *            → CDP validation on connect_url → view-token live view → BrowserSession row
 *            (validation failure or row failure releases the paid session)
 * close:   release (DELETE; 204/404/410 = released, 503 retried) → PAUSED/CLOSED,
 *            or ACTIVE/ERROR when release failed. Pause snapshots browser state first.
 * resume:  live ACTIVE Tilion session → reattach in place (fresh connect/view tokens)
 *          otherwise → replacement session carrying cookies/localStorage/IndexedDB + URL
 * rotate:  replacement session on a fresh residential or mobile exit, state carried
 *
 * Tilion admits ONE CDP client per session (a second socket closes with 4409).
 * Every helper here that opens CDP does so only on a session it just created
 * (before the worker attaches) or as a best-effort read that tolerates 4409.
 * Account-wide saved logins (`/v1/auth*`) are never used: browser state moves
 * only through the provider-neutral injection path and this module's carry.
 */
import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import { prisma } from '../database';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import { createLogger } from '../logger';
import { connectValidatedBrowser } from '../steel/sessionConnection';
import { browserProviderEnabled } from './config';
import type { KernelProxyType } from './kernelProxy';
import { rotationGeolocation } from './rotationGeolocation';
import { announceBrowserSessionBinding } from './sessionBindingAnnounce';
import { persistBrowserSessionRow } from './sessionPersist';
import {
  mintTilionConnectUrl,
  mintTilionLiveViewUrl,
  TilionApiError,
  tilionRequest,
  tilionRequestWithMeta,
  tilionSessionPath,
  type TilionError,
} from './tilionClient';
import type {
  BrowserProviderName,
  BrowserProviderResumeSession,
  BrowserProviderSession,
} from './types';

import {
  harvestBrowserState,
  rememberPausedState,
  restoreTilionBrowserState,
  takePausedState,
} from './tilionState';
import { forgetTilionSessionDownloads } from './tilionSessionIo';
import { agentLocation, rotateInPlace } from './tilionRotateInPlace';

export {
  captureTilionScreenshot,
  getTilionCaptchaTelemetry,
  getTilionLiveViewUrl,
  getTilionSessionHealth,
  refreshTilionConnectUrl,
  forgetTilionSessionDownloads,
  listTilionSessionFiles,
  pressTilionKeys,
  readTilionSessionFile,
  recordTilionSessionDownload,
  uploadTilionSessionFile,
} from './tilionSessionIo';
export { restoreTilionBrowserState } from './tilionState';
export {
  TilionApiError,
  TilionInsufficientCreditsError,
  TilionRateLimitError,
  TilionSessionBusyError,
  TilionTimeoutError,
} from './tilionClient';

const log = createLogger('Tilion');

export type TilionReplacementSession = BrowserProviderResumeSession & {
  previousSessionId: string;
  previousProvider: BrowserProviderName;
};

type TilionProxyType = 'residential' | 'mobile';
type GeoSpecificity = 'city' | 'state' | 'country';

interface TilionSessionRecord {
  session_id: string;
  state: string;
  created_at: number | null;
  last_active?: number | null;
  idle_timeout?: number | null;
  ttl?: number | null;
  expires_at?: number | null;
  closed_at?: number | null;
  reason?: string | null;
  connect_url?: string | null;
  exit_id?: string | null;
  geo_applied?: boolean | null;
  geo_unsupported?: string[] | null;
}

interface RemoteTilionSession {
  sessionId: string;
  wsUrl: string;
  debugUrl: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  proxyType: TilionProxyType;
  browser: Browser;
}

class TilionSessionValidationError extends Error {}

/** DELETE could not be confirmed after bounded retries; the paid browser may still run. */
export class TilionSessionReleaseError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, cause: unknown) {
    super(
      `Tilion session ${sessionId} release was not confirmed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
    this.name = 'TilionSessionReleaseError';
    this.sessionId = sessionId;
  }
}

// ── configuration ────────────────────────────────────────────────────────────

/** The browser activity budget (30 min) plus the 5 min margin the plan requires. */
export const TILION_MIN_TTL_SECONDS = 35 * 60;
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got ${raw}`);
  }
  return value;
}

export function tilionSessionLifetime(): { ttl: number; idleTimeout: number } {
  return {
    ttl: integerEnv(
      'TILION_SESSION_TTL_SECONDS',
      DEFAULT_TTL_SECONDS,
      TILION_MIN_TTL_SECONDS,
      43_200
    ),
    idleTimeout: integerEnv('TILION_IDLE_TIMEOUT_SECONDS', DEFAULT_IDLE_TIMEOUT_SECONDS, 1, 3600),
  };
}

let regionCache: { codes: Set<string>; fetchedAt: number } | null = null;
const REGION_CACHE_MS = 10 * 60_000;

async function regionForCountry(country: string): Promise<string | undefined> {
  const code = country.trim().toLowerCase();
  if (regionCache === null || Date.now() - regionCache.fetchedAt > REGION_CACHE_MS) {
    try {
      const regions = await tilionRequest<Array<{ code: string }>>('/v1/regions', {
        retryOnTimeout: true,
      });
      regionCache = {
        codes: new Set(regions.map((r) => r.code.toLowerCase())),
        fetchedAt: Date.now(),
      };
    } catch (error) {
      // The residential geo still pins the exit country; only timezone/locale
      // placement is left to Tilion's nearest region.
      log.warn('Tilion region list unavailable; omitting region', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
  return regionCache.codes.has(code) ? code : undefined;
}

export function resetTilionRegionCacheForTests(): void {
  regionCache = null;
}

function tilionProxyType(proxyType: KernelProxyType): TilionProxyType {
  if (proxyType === 'residential' || proxyType === 'mobile') return proxyType;
  throw new Error(`Tilion has no ${proxyType} exit; expected residential or mobile`);
}

function geoSpecificities(location: ProxyGeoLocation): GeoSpecificity[] {
  if (location.city && location.state) return ['city', 'state', 'country'];
  if (location.state) return ['state', 'country'];
  return ['country'];
}

function geoForSpecificity(location: ProxyGeoLocation, specificity: GeoSpecificity) {
  return {
    country: location.country.trim().toLowerCase(),
    ...(specificity !== 'country' && location.state
      ? { state: location.state.trim().toLowerCase() }
      : {}),
    ...(specificity === 'city' && location.city
      ? { city: location.city.trim().toLowerCase().replace(/\s+/g, '') }
      : {}),
  };
}

function landedLocation(location: ProxyGeoLocation, specificity: GeoSpecificity): ProxyGeoLocation {
  return {
    country: location.country,
    ...(specificity !== 'country' && location.state ? { state: location.state } : {}),
    ...(specificity === 'city' && location.city ? { city: location.city } : {}),
  };
}

// ── session create ───────────────────────────────────────────────────────────

async function postSession(
  location: ProxyGeoLocation,
  proxyType: TilionProxyType,
  specificity: GeoSpecificity
): Promise<TilionSessionRecord> {
  const { ttl, idleTimeout } = tilionSessionLifetime();
  const region = await regionForCountry(location.country);
  return tilionRequest<TilionSessionRecord>('/v1/session', {
    method: 'POST',
    // One key per logical create: a retried request after a lost reply returns
    // the same session instead of paying for a second browser.
    idempotencyKey: `rose-${randomUUID()}`,
    retryOnTimeout: true,
    body: {
      ttl,
      idle_timeout: idleTimeout,
      cdp_observe: browserProviderEnabled('TILION_CDP_OBSERVE', true),
      residential: true,
      proxy_type: proxyType,
      ...(region ? { region } : {}),
      geo: geoForSpecificity(location, specificity),
    },
  });
}

/** Create on the most specific geo Tilion honours: city → state → country. */
async function createPlacedSession(
  location: ProxyGeoLocation,
  proxyType: TilionProxyType
): Promise<{ record: TilionSessionRecord; specificity: GeoSpecificity }> {
  const ladder = geoSpecificities(location);
  for (let index = 0; index < ladder.length; index++) {
    const specificity = ladder[index];
    const record = await postSession(location, proxyType, specificity);
    const unsupported = record.geo_unsupported ?? [];
    const honoured = record.geo_applied !== false && unsupported.length === 0;
    if (honoured || specificity === 'country') return { record, specificity };
    // Tilion fell back to the country exit. A less specific pin can still beat it.
    const next = ladder[index + 1];
    if (next === 'country') {
      log.info('Tilion geo state unsupported; keeping country exit', {
        sessionId: record.session_id,
        unsupported,
      });
      return { record, specificity: 'country' };
    }
    log.info('Tilion geo unsupported; recreating with a wider pin', {
      sessionId: record.session_id,
      requested: specificity,
      next,
      unsupported,
    });
    await releaseTilionRemoteSession(record.session_id);
  }
  throw new Error('Tilion geo ladder exhausted');
}

async function createRemote(
  location: ProxyGeoLocation,
  proxyType: TilionProxyType
): Promise<RemoteTilionSession> {
  for (let attempt = 1; ; attempt++) {
    const { record, specificity } = await createPlacedSession(location, proxyType);
    const sessionId = record.session_id;
    let browser: Browser | null = null;
    try {
      if (!sessionId || !record.connect_url) {
        throw new TilionSessionValidationError(
          'Tilion create response omitted session_id or connect_url (raw CDP not enabled for this key?)'
        );
      }
      browser = await connectValidatedBrowser(record.connect_url);
      if (browser === null) {
        throw new TilionSessionValidationError(`Tilion session ${sessionId} failed CDP validation`);
      }
      const debugUrl = await mintTilionLiveViewUrl(sessionId);
      log.info('Created Tilion browser session', {
        sessionId,
        proxyType,
        specificity,
        exitId: record.exit_id ?? null,
      });
      return {
        sessionId,
        wsUrl: record.connect_url,
        debugUrl,
        proxySource: `tilion_${proxyType}_${specificity}`,
        proxyLocation: landedLocation(location, specificity),
        proxyType,
        browser,
      };
    } catch (error) {
      await browser?.close().catch(() => {});
      if (sessionId) {
        try {
          await releaseTilionRemoteSession(sessionId);
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            `Tilion session ${sessionId} failed validation and cleanup`
          );
        }
      }
      if (error instanceof TilionSessionValidationError && attempt < 2) {
        log.warn('Tilion session failed validation; creating another', {
          sessionId,
          error: error.message,
        });
        continue;
      }
      throw error;
    }
  }
}

/**
 * New Tilion session for a task. With `keepValidationConnection`, the returned
 * `validationBrowser` is the session's only CDP client and the CALLER owns it:
 * it must close it before the agent worker attaches, or the worker's socket is
 * refused with 4409.
 */
export async function createTilionSessionWithContext(
  contextId: string,
  agentId: string,
  location: ProxyGeoLocation = DEFAULT_GEOLOCATION,
  startUrl?: string,
  options?: { keepValidationConnection?: boolean; taskId?: string; proxyType?: KernelProxyType }
): Promise<BrowserProviderSession> {
  const proxyType = tilionProxyType(options?.proxyType ?? 'residential');
  const remote = await createRemote(location, proxyType);
  let row;
  try {
    row = await persistBrowserSessionRow({
      taskId: options?.taskId,
      contextId,
      agentId,
      sessionId: remote.sessionId,
      debugUrl: remote.debugUrl,
      wsUrl: remote.wsUrl,
      startUrl: startUrl || undefined,
      provider: 'tilion',
      providerProfileId: null,
      providerProfileSource: 'tilion_ephemeral',
      kernelProxySource: remote.proxySource,
      releaseRemoteSession: releaseTilionRemoteSession,
    });
  } catch (error) {
    await Promise.allSettled([
      remote.browser.close(),
      releaseTilionRemoteSession(remote.sessionId),
    ]);
    throw error;
  }
  const keep = options?.keepValidationConnection === true;
  if (!keep) await remote.browser.close().catch(() => {});
  return {
    provider: 'tilion',
    sessionId: remote.sessionId,
    debugUrl: remote.debugUrl,
    taskId: row.id,
    wsUrl: remote.wsUrl,
    proxySource: remote.proxySource,
    proxyLocation: remote.proxyLocation,
    profileId: null,
    profileSource: 'tilion_ephemeral',
    validationBrowser: keep ? remote.browser : null,
  };
}

/** Row-free candidate for challenge recovery; the caller owns the browser and the release. */
export async function createTilionRecoverySession(
  location: ProxyGeoLocation,
  options: { proxyType?: KernelProxyType } = {}
): Promise<{
  sessionId: string;
  debugUrl: string;
  wsUrl: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  profileId: null;
  profileSource: string;
  validationBrowser: Browser | null;
}> {
  const remote = await createRemote(location, tilionProxyType(options.proxyType ?? 'residential'));
  return {
    sessionId: remote.sessionId,
    debugUrl: remote.debugUrl,
    wsUrl: remote.wsUrl,
    proxySource: remote.proxySource,
    proxyLocation: remote.proxyLocation,
    profileId: null,
    profileSource: 'challenge_candidate_ephemeral',
    validationBrowser: remote.browser,
  };
}

// ── release / close ──────────────────────────────────────────────────────────

/** Idempotent remote release: 204/404/410 count as released; bounded retries on 429/5xx. */
export async function releaseTilionRemoteSession(sessionId: string): Promise<void> {
  try {
    await tilionRequestWithMeta<null>(tilionSessionPath(sessionId), {
      method: 'DELETE',
      acceptStatuses: [404, 410],
      retryOnTimeout: true,
      maxAttempts: 4,
      // 503 "retry cleanup" means the browser is not confirmed gone.
      shouldRetry: (error: TilionError) => [429, 500, 502, 503, 504].includes(error.status),
    });
  } catch (error) {
    throw new TilionSessionReleaseError(sessionId, error);
  }
  forgetTilionSessionDownloads(sessionId);
}

export async function closeTilionSession(
  sessionId: string,
  pause = false,
  currentUrl?: string
): Promise<void> {
  if (pause) {
    const state = await harvestBrowserState({ provider: 'tilion', sessionId, wsUrl: null });
    if (state !== null) rememberPausedState(sessionId, state);
  }
  let releaseError: unknown = null;
  try {
    await releaseTilionRemoteSession(sessionId);
  } catch (error) {
    releaseError = error;
    log.warn('Failed to release Tilion session; retaining retryable local session state', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await prisma.browserSession.update({
    where: { sessionId },
    data: {
      status: releaseError === null ? (pause ? 'PAUSED' : 'CLOSED') : pause ? 'ACTIVE' : 'ERROR',
      closedAt: releaseError === null && !pause ? new Date() : null,
      currentUrl: currentUrl || undefined,
    },
  });
  await announceBrowserSessionBinding({ sessionId });
  if (releaseError !== null) throw releaseError;
}

// ── resume / rotate ──────────────────────────────────────────────────────────

function storedProvider(value: string): BrowserProviderName {
  return value === 'kernel' || value === 'browser-use' || value === 'tilion' ? value : 'steel';
}

type OldRow = Awaited<ReturnType<typeof prisma.browserSession.findUniqueOrThrow>>;

/** Deploy drain / worker restart: the old Tilion session is still alive, so reattach to it. */
async function reattachLiveSession(
  old: OldRow,
  options: { keepValidationConnection?: boolean }
): Promise<TilionReplacementSession | null> {
  let status: TilionSessionRecord;
  try {
    status = await tilionRequest<TilionSessionRecord>(tilionSessionPath(old.sessionId, '/status'), {
      retryOnTimeout: true,
    });
  } catch {
    return null;
  }
  if (status.state !== 'ready') return null;
  const wsUrl = await mintTilionConnectUrl(old.sessionId).catch(() => null);
  if (wsUrl === null) return null;
  const browser = await connectValidatedBrowser(wsUrl);
  if (browser === null) return null;
  let handedOff = false;
  try {
    const debugUrl = await mintTilionLiveViewUrl(old.sessionId);
    const updated = await prisma.browserSession.updateMany({
      where: { id: old.id, sessionId: old.sessionId },
      data: { wsUrl, debugUrl, status: 'ACTIVE', closedAt: null },
    });
    if (updated.count !== 1) throw new Error(`Browser task ${old.id} changed during reattach`);
    await announceBrowserSessionBinding({ id: old.id });
    handedOff = true;
    const proxyType: TilionProxyType = old.proxyTier === 'mobile' ? 'mobile' : 'residential';
    return {
      ...(options.keepValidationConnection ? { validationBrowser: browser } : {}),
      provider: 'tilion',
      sessionId: old.sessionId,
      debugUrl,
      wsUrl,
      savedUrl: old.currentUrl || old.startUrl || undefined,
      proxySource: old.kernelProxySource ?? `tilion_${proxyType}_country`,
      proxyLocation: await agentLocation(old.agentId),
      profileId: null,
      profileSource: 'tilion_reattached',
      // Same id: the caller must not release the "superseded" session.
      previousSessionId: old.sessionId,
      previousProvider: 'tilion',
    };
  } finally {
    if (!options.keepValidationConnection || !handedOff) await browser.close().catch(() => {});
  }
}

async function replaceSession(
  taskId: string,
  options: {
    forceFreshProfile?: boolean;
    keepValidationConnection?: boolean;
    rotateTo?: TilionProxyType;
  }
): Promise<TilionReplacementSession> {
  const old = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
  const previousProvider = storedProvider(old.provider);
  const live = old.status === 'ACTIVE';

  if (
    options.rotateTo === undefined &&
    previousProvider === 'tilion' &&
    live &&
    !options.forceFreshProfile
  ) {
    const reattached = await reattachLiveSession(old, options);
    if (reattached !== null) return reattached;
  }

  const carried = options.forceFreshProfile
    ? null
    : live
      ? await harvestBrowserState({
          provider: previousProvider,
          sessionId: old.sessionId,
          wsUrl: old.wsUrl,
        })
      : null;
  const state = carried ?? (options.forceFreshProfile ? null : takePausedState(old.sessionId));

  const baseLocation = await agentLocation(old.agentId);
  // A rotation must land elsewhere; like Kernel, move to another state and drop the city.
  const location =
    options.rotateTo !== undefined
      ? rotationGeolocation(baseLocation, taskId, old.proxyRotationCount)
      : baseLocation;
  const proxyType: TilionProxyType =
    options.rotateTo ??
    (previousProvider === 'tilion' && old.proxyTier === 'mobile' ? 'mobile' : 'residential');

  const remote = await createRemote(location, proxyType);
  let handedOff = false;
  try {
    if (state !== null) {
      const restored = await restoreTilionBrowserState(remote.browser, state);
      log.info('Carried browser state into Tilion replacement', {
        taskId,
        sessionId: remote.sessionId,
        previousSessionId: old.sessionId,
        ...restored,
      });
    }
    const replaced = await prisma.browserSession.updateMany({
      where: { id: taskId, sessionId: old.sessionId },
      data: {
        sessionId: remote.sessionId,
        debugUrl: remote.debugUrl,
        wsUrl: remote.wsUrl,
        status: 'ACTIVE',
        closedAt: null,
        provider: 'tilion',
        providerProfileId: null,
        providerProfileSource: 'tilion_ephemeral',
        providerProfilePersist: true,
        kernelProxySource: remote.proxySource,
        proxyTier: proxyType,
      },
    });
    if (replaced.count !== 1) throw new Error(`Browser task ${taskId} changed during replacement`);
    await announceBrowserSessionBinding({ id: taskId });

    const savedUrl = old.currentUrl || old.startUrl || undefined;
    if (savedUrl) {
      try {
        const context = remote.browser.contexts()[0];
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      } catch (error) {
        // The row is committed; the worker can navigate after attaching.
        log.warn('Tilion replacement could not restore saved URL', {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    handedOff = true;
    return {
      ...(options.keepValidationConnection ? { validationBrowser: remote.browser } : {}),
      provider: 'tilion',
      debugUrl: remote.debugUrl,
      sessionId: remote.sessionId,
      wsUrl: remote.wsUrl,
      savedUrl,
      proxySource: remote.proxySource,
      proxyLocation: remote.proxyLocation,
      profileId: null,
      profileSource: state !== null ? 'tilion_carried_state' : 'tilion_ephemeral',
      previousSessionId: old.sessionId,
      previousProvider,
    };
  } catch (error) {
    await releaseTilionRemoteSession(remote.sessionId).catch(() => {});
    throw error;
  } finally {
    if (!options.keepValidationConnection || !handedOff)
      await remote.browser.close().catch(() => {});
  }
}

/**
 * Resume the task's browser on Tilion. A still-live Tilion session (deploy
 * drain) is reattached in place and returned with `previousSessionId ===
 * sessionId`; otherwise a replacement carries the previous browser state and
 * saved URL. The caller releases a superseded previous session.
 */
export async function resumeTilionSession(
  taskId: string,
  options: { forceFreshProfile?: boolean; keepValidationConnection?: boolean } = {}
): Promise<TilionReplacementSession> {
  return replaceSession(taskId, options);
}

/**
 * Rotation step on Tilion: a replacement session on a fresh exit of the
 * requested type (residential → new residential exit in another state, mobile
 * → `proxy_type: mobile`), browser state carried, proxy tier persisted. Same
 * return semantics as rotateKernelSession plus the previous binding.
 */
export async function rotateTilionSession(
  taskId: string,
  proxyType: KernelProxyType,
  options: { keepValidationConnection?: boolean } = {}
): Promise<TilionReplacementSession> {
  const rotateTo = tilionProxyType(proxyType);
  if (rotateTo === 'residential') {
    const inPlace = await rotateInPlace(taskId, options);
    if (inPlace !== null) return inPlace;
  }
  return replaceSession(taskId, { ...options, rotateTo });
}

// ── account listing ──────────────────────────────────────────────────────────

/** Live Tilion session ids for this API key (account-wide; never implies ownership). */
export async function listLiveTilionSessionIds(): Promise<string[]> {
  const sessions = await tilionRequest<TilionSessionRecord[]>('/v1/sessions', {
    retryOnTimeout: true,
  });
  return (sessions ?? []).map((session) => session.session_id).filter(Boolean);
}

export function isTilionSessionEndedError(error: unknown): boolean {
  return error instanceof TilionApiError && (error.status === 404 || error.status === 410);
}
