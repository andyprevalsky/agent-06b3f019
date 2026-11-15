/**
 * Tilion Cloud browser sessions, exposed through the same CDP contract as
 * Steel, Kernel and Browser Use. See docs/plans/completed/tilion-browser-provider.md.
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
  postTilionSession,
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
  settleFailedTilionCreate,
  TILION_REPLACEMENT_CREATE_ATTEMPTS,
  TILION_TASK_CREATE_ATTEMPTS,
  TilionSessionValidationError,
  type TilionValidationAttempt,
} from './tilionCreateValidation';

import {
  type StorageState,
  harvestBrowserState,
  savePausedState,
  loadPausedState,
  clearPausedState,
  restoreTilionBrowserState,
} from './tilionState';
import {
  geoForSpecificity,
  geoSpecificities,
  type GeoSpecificity,
  regionForCountry,
  storedTilionProxyType,
  TILION_DEFAULT_PROXY_TYPE,
  tilionExitPlacement,
  tilionProxyType,
  type TilionProxyType,
  tilionSessionLifetime,
} from './tilionConfig';
import { agentLocation, rotateInPlace } from './tilionRotateInPlace';

export {
  captureTilionScreenshot,
  getTilionCaptchaTelemetry,
  getTilionLiveViewUrl,
  getTilionSessionHealth,
  refreshTilionConnectUrl,
  listTilionSessionFiles,
  pressTilionKeys,
  readTilionSessionFile,
  uploadTilionSessionFile,
} from './tilionSessionIo';
export { restoreTilionBrowserState, type StorageState as TilionCarriedState } from './tilionState';
export {
  resetTilionRegionCacheForTests,
  TILION_MIN_TTL_SECONDS,
  tilionExitCountry,
  tilionSessionLifetime,
} from './tilionConfig';
export {
  TilionApiError,
  TilionInsufficientCreditsError,
  TilionRateLimitError,
  TilionSessionBusyError,
  TilionTimeoutError,
} from './tilionClient';

const log = createLogger('Tilion');

export type TilionReplacementSession = BrowserProviderResumeSession & {
  /** Null when the row was an unmaterialized logical browser (no provider session). */
  previousSessionId: string | null;
  previousProvider: BrowserProviderName;
  /** Requested vs applied exit placement of a newly created replacement. */
  geoTargeting?: TilionGeoTargeting;
};

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
  /** Set locally by postSession: false when a direct exit had no region to place it. */
  placed?: boolean;
}

interface RemoteTilionSession {
  sessionId: string;
  wsUrl: string;
  debugUrl: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  proxyType: TilionProxyType;
  browser: Browser;
  geoTargeting: TilionGeoTargeting;
}

/** A live Tilion session would be replaced without the worker-captured browser state. */
export class TilionUncarriedStateError extends Error {
  readonly taskId: string;
  readonly sessionId: string;
  constructor(taskId: string, sessionId: string) {
    super(
      `Tilion task ${taskId}: live session ${sessionId} has uncarried browser state; ` +
        'the caller must pass the worker-captured carriedState'
    );
    this.name = 'TilionUncarriedStateError';
    this.taskId = taskId;
    this.sessionId = sessionId;
  }
}

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

// ── session create ───────────────────────────────────────────────────────────

async function postSession(
  location: ProxyGeoLocation,
  proxyType: TilionProxyType,
  specificity: GeoSpecificity
): Promise<TilionSessionRecord> {
  const { ttl, idleTimeout } = tilionSessionLifetime();
  const region = await regionForCountry(location.country);
  // One key per logical create: a retried request after a lost reply returns
  // the same session instead of paying for a second browser.
  const idempotencyKey = `rose-${randomUUID()}`;
  const record = await postTilionSession<TilionSessionRecord>(idempotencyKey, {
    ttl,
    idle_timeout: idleTimeout,
    // Live probe: cdp_observe solved neither reCAPTCHA v2 nor Turnstile and
    // adds 100-250 ms per navigation, so it is opt-in.
    cdp_observe: browserProviderEnabled('TILION_CDP_OBSERVE', false),
    // Direct egress has no exit geo: the region alone places the browser.
    ...(proxyType === 'direct'
      ? { residential: false }
      : {
          residential: true,
          proxy_type: proxyType,
          geo: geoForSpecificity(location, specificity),
        }),
    ...(region ? { region } : {}),
  });
  // Exact-cleanup evidence: the paid browser exists from here on. Logged before
  // any further await so a process dying during validation still leaves the id
  // (scripts/cloudbench-exact-session-cleanup.py matches this message + sessionId).
  // Without an id the field is omitted, never printed as `sessionId=null`
  // (which a parser could read as an id); exact cleanup then fails closed.
  log.info('Tilion session allocated', {
    ...(record?.session_id ? { sessionId: record.session_id } : {}),
    idempotencyKey,
    proxyType,
  });
  // Residential geo pins the exit country; a direct exit has only its region.
  return { ...record, placed: proxyType !== 'direct' || region !== undefined };
}

/**
 * Requested vs applied exit placement. Tilion residential exits honour only
 * the country (live 2026-10-21: state, city and zip all `geo_unsupported`), so
 * a narrower agent location is recorded as a gap instead of paying for creates
 * Tilion would refuse.
 */
export interface TilionGeoTargeting {
  requested: GeoSpecificity;
  applied: GeoSpecificity;
  requestedLocation: ProxyGeoLocation;
  geoApplied: boolean | null;
  geoUnsupported: string[];
}

/** One create pinned to the country, the only placement Tilion honours. */
async function createPlacedSession(
  location: ProxyGeoLocation,
  proxyType: TilionProxyType
): Promise<{ record: TilionSessionRecord; geoTargeting: TilionGeoTargeting }> {
  const record = await postSession(location, proxyType, 'country');
  const geoTargeting: TilionGeoTargeting = {
    requested: geoSpecificities(location)[0],
    applied: 'country',
    requestedLocation: location,
    geoApplied: proxyType === 'direct' ? null : (record.geo_applied ?? null),
    geoUnsupported: record.geo_unsupported ?? [],
  };
  if (geoTargeting.requested !== 'country' || geoTargeting.geoApplied === false) {
    log.warn('Tilion exit placed at country level; narrower targeting unavailable', {
      sessionId: record.session_id,
      ...geoTargeting,
    });
  }
  return { record, geoTargeting };
}

async function createRemote(
  location: ProxyGeoLocation,
  proxyType: TilionProxyType,
  maxAttempts: number
): Promise<RemoteTilionSession> {
  // A dead worker refuses CDP *and* DELETE (ALB 503, 2026-11-13): an unconfirmed
  // release must not stop the next create, which lands on another worker.
  const failed: TilionValidationAttempt[] = [];
  for (let attempt = 1; ; attempt++) {
    const { record, geoTargeting } = await createPlacedSession(location, proxyType);
    const sessionId = record.session_id;
    let browser: Browser | null = null;
    try {
      if (!sessionId) {
        throw new TilionSessionValidationError('Tilion create response omitted session_id');
      }
      if (!record.connect_url) {
        // A key without raw CDP never gets a connect_url: another create cannot help.
        throw new Error(
          `Tilion session ${sessionId} has no connect_url (raw CDP not enabled for this key?)`
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
        requestedGeo: geoTargeting.requested,
        appliedGeo: geoTargeting.applied,
        exitId: record.exit_id ?? null,
      });
      return {
        sessionId,
        wsUrl: record.connect_url,
        debugUrl,
        ...tilionExitPlacement(proxyType, record.placed === true, location),
        proxyType,
        browser,
        geoTargeting,
      };
    } catch (error) {
      await browser?.close().catch(() => {});
      // Returns only when another create should run; otherwise throws the outcome.
      await settleFailedTilionCreate(
        error,
        sessionId,
        attempt < maxAttempts,
        failed,
        releaseTilionRemoteSession
      );
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
  options?: {
    keepValidationConnection?: boolean;
    taskId?: string;
    proxyType?: KernelProxyType | 'direct';
  }
): Promise<BrowserProviderSession & { geoTargeting: TilionGeoTargeting }> {
  const proxyType = tilionProxyType(options?.proxyType ?? TILION_DEFAULT_PROXY_TYPE);
  const remote = await createRemote(location, proxyType, TILION_TASK_CREATE_ATTEMPTS);
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
    // Recovery keys avoided exits on the tier (tilion_mobile vs tilion_residential).
    await prisma.browserSession.updateMany({
      where: { id: row.id, sessionId: remote.sessionId },
      data: { proxyTier: proxyType },
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
    geoTargeting: remote.geoTargeting,
  };
}

/** Row-free candidate for challenge recovery; the caller owns the browser and the release. */
export async function createTilionRecoverySession(
  location: ProxyGeoLocation,
  options: { proxyType?: KernelProxyType | 'direct' } = {}
): Promise<{
  sessionId: string;
  debugUrl: string;
  wsUrl: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  profileId: null;
  profileSource: string;
  validationBrowser: Browser | null;
  geoTargeting: TilionGeoTargeting;
}> {
  const remote = await createRemote(
    location,
    tilionProxyType(options.proxyType ?? TILION_DEFAULT_PROXY_TYPE),
    TILION_REPLACEMENT_CREATE_ATTEMPTS
  );
  return {
    sessionId: remote.sessionId,
    debugUrl: remote.debugUrl,
    wsUrl: remote.wsUrl,
    proxySource: remote.proxySource,
    proxyLocation: remote.proxyLocation,
    profileId: null,
    profileSource: 'challenge_candidate_ephemeral',
    validationBrowser: remote.browser,
    geoTargeting: remote.geoTargeting,
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
}

export async function closeTilionSession(
  sessionId: string,
  pause = false,
  currentUrl?: string
): Promise<void> {
  if (pause) {
    const state = await harvestBrowserState({ provider: 'tilion', sessionId, wsUrl: null });
    if (state !== null) {
      await savePausedState(sessionId, state).catch((error: unknown) =>
        log.warn('Could not store paused Tilion browser state', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
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
  if (releaseError === null && !pause) await clearPausedState({ sessionId });
  await announceBrowserSessionBinding({ sessionId });
  if (releaseError !== null) throw releaseError;
}

/** `/status` (no idle-clock reset); an unreadable status counts as live, failing closed. */
async function tilionSessionStillLive(sessionId: string): Promise<boolean> {
  try {
    const record = await tilionRequest<TilionSessionRecord>(
      tilionSessionPath(sessionId, '/status'),
      {
        retryOnTimeout: true,
      }
    );
    return record.state === 'ready' || record.state === 'remote';
  } catch (error) {
    return !isTilionSessionEndedError(error);
  }
}

// ── resume / rotate ──────────────────────────────────────────────────────────

function storedProvider(value: string): BrowserProviderName {
  return value === 'kernel' || value === 'browser-use' || value === 'tilion' ? value : 'steel';
}

type OldRow = Awaited<ReturnType<typeof prisma.browserSession.findUniqueOrThrow>>;

/** Deploy drain / worker restart: the old Tilion session is still alive, so reattach to it. */
async function reattachLiveSession(
  old: OldRow & { sessionId: string },
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
      data: { wsUrl, debugUrl, status: old.logicalOwnerKey ? 'PAUSED' : 'ACTIVE', closedAt: null },
    });
    if (updated.count !== 1) throw new Error(`Browser task ${old.id} changed during reattach`);
    await announceBrowserSessionBinding({ id: old.id });
    handedOff = true;
    const proxyType = storedTilionProxyType(old.proxyTier);
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
    carriedState?: StorageState;
  }
): Promise<TilionReplacementSession> {
  const old = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
  const previousProvider = storedProvider(old.provider);
  const live = old.status === 'ACTIVE';

  const oldSessionId = old.sessionId;
  if (
    options.rotateTo === undefined &&
    previousProvider === 'tilion' &&
    live &&
    oldSessionId !== null &&
    !options.forceFreshProfile
  ) {
    const reattached = await reattachLiveSession({ ...old, sessionId: oldSessionId }, options);
    if (reattached !== null) return reattached;
  }

  // A live Tilion session may hold the worker's CDP socket (the only client
  // Tilion admits), so the backend never connects to it mid-run: the worker
  // captures its state and passes it as `carriedState`. Other providers admit
  // a second client and are harvested directly.
  let carried: StorageState | null = options.forceFreshProfile
    ? null
    : (options.carriedState ?? null);
  // An unmaterialized logical browser (no provider session yet) has nothing to carry.
  if (carried === null && !options.forceFreshProfile && live && oldSessionId !== null) {
    if (previousProvider !== 'tilion') {
      carried = await harvestBrowserState({
        provider: previousProvider,
        sessionId: oldSessionId,
        wsUrl: old.wsUrl,
      });
    } else if (await tilionSessionStillLive(oldSessionId)) {
      // The old browser still holds state nobody handed us: never swap it for a blank one.
      throw new TilionUncarriedStateError(taskId, oldSessionId);
    }
  }
  const state =
    carried ??
    (options.forceFreshProfile || oldSessionId === null
      ? null
      : await loadPausedState(taskId, oldSessionId));

  const baseLocation = await agentLocation(old.agentId);
  // A rotation must land elsewhere; like Kernel, move to another state and drop the city.
  const location =
    options.rotateTo !== undefined
      ? rotationGeolocation(baseLocation, taskId, old.proxyRotationCount)
      : baseLocation;
  const proxyType: TilionProxyType =
    options.rotateTo ??
    (previousProvider === 'tilion'
      ? storedTilionProxyType(old.proxyTier)
      : TILION_DEFAULT_PROXY_TYPE);

  const remote = await createRemote(location, proxyType, TILION_REPLACEMENT_CREATE_ATTEMPTS);
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
        // Logical rows go ACTIVE only after the checkpoint restore (same contract as Kernel).
        status: old.logicalOwnerKey ? 'PAUSED' : 'ACTIVE',
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
    // The snapshot now lives in the replacement browser; never replay it twice.
    await clearPausedState({ taskId });
    await announceBrowserSessionBinding({ id: taskId });

    const savedUrl = old.currentUrl || old.startUrl || undefined;
    // Logical resume restores cookies, localStorage and IndexedDB before its
    // tabs navigate. Opening the merchant first can hold IndexedDB open while
    // Playwright's storage restore waits for that same database to close.
    if (savedUrl && !old.logicalOwnerKey) {
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
      geoTargeting: remote.geoTargeting,
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
  options: {
    forceFreshProfile?: boolean;
    keepValidationConnection?: boolean;
    /** Worker-captured cookies/localStorage/IndexedDB (Playwright storageState shape). */
    carriedState?: StorageState;
  } = {}
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
  options: { keepValidationConnection?: boolean; carriedState?: StorageState } = {}
): Promise<TilionReplacementSession> {
  const rotateTo = tilionProxyType(proxyType);
  if (rotateTo === 'residential') {
    const inPlace = await rotateInPlace(taskId);
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
