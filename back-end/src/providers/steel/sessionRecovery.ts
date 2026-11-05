/**
 * Steel challenge-recovery session factory (profile-free, solver-enabled).
 * Kept out of session.ts so max-lines stays under the lint budget.
 */

import type { Browser } from 'playwright';
import type { ProxyGeoLocation } from '../geoip';
import { steelStartupProbe, validateBrowserConnection } from './sessionConnection';
import { installCaptchaSolveIndicator } from '../browser/captchaSolveIndicator';
import {
  buildSteelProxySettings,
  isInvalidSteelProxyConfiguration,
  isKnownRejectedProxyCity,
  rememberRejectedProxyCity,
  releaseSteelRemoteSession,
  steel,
  type SteelProxyConfig,
} from './session';
import { MAX_SESSION_RETRIES, sleepBeforeSteelRetry } from './sessionRetry';
import { steelSessionTimeoutMs } from './sessionLifetime';
import { newOwnedSteelSessionId, registerInFlightSteelSession } from './sessionIdentity';
import { log } from './types';
import { fingerprintInjectionEnabled } from './fingerprintSwitch';
import { steelCdpUrl, steelDebugUrl } from './urls';

interface SteelSessionResult {
  id: string;
  debugUrl: string;
  profileId?: string | null;
  proxySource?: string | null;
}

/** Create a solver-enabled, profile-free Steel candidate for challenge search. */
export function buildSteelRecoveryBrowserOptions(input: {
  proxy: SteelProxyConfig;
  userAgent?: string;
}) {
  return {
    sessionId: newOwnedSteelSessionId(),
    persistProfile: false,
    // A carried user agent (the live page's) is a fingerprint override too.
    userAgent: fingerprintInjectionEnabled() ? input.userAgent : undefined,
    useProxy: input.proxy,
    solveCaptcha: true,
    debugConfig: { systemCursor: false },
    stealthConfig: { humanizeInteractions: false, skipFingerprintInjection: true },
    timeout: steelSessionTimeoutMs(),
    dimensions: { width: 1288, height: 891 },
  };
}

export async function createSteelRecoverySession(
  input: {
    proxyLocation: ProxyGeoLocation;
    proxyMode: 'managed' | 'fixed';
    userAgent?: string;
  },
  deps?: {
    createSession?: (options: ReturnType<typeof buildSteelRecoveryBrowserOptions>) => Promise<{
      id: string;
      debugUrl: string;
      profileId?: string | null;
      proxySource?: string | null;
    }>;
    connect?: (wsUrl: string) => Promise<Browser>;
    retrieveSession?: (id: string) => Promise<{ status: string; releaseReason?: unknown }>;
    releaseRemoteSession?: typeof releaseSteelRemoteSession;
  }
) {
  // Match createSessionWithContext: Steel 400s "Invalid proxy configuration" on
  // unsupported city-level residential targets. Challenge recovery used a single
  // create with no city-drop retry, so Stripe (preferSteel → steel_managed) failed
  // closed whenever the live session geo city was unsupported (prod: DALLAS).
  let dropProxyCity =
    input.proxyMode === 'managed' && isKnownRejectedProxyCity(input.proxyLocation);
  let lastError: Error | null = null;
  const createSession = deps?.createSession ?? ((options) => steel.sessions.create(options));
  const retrieveSession = deps?.retrieveSession ?? ((id: string) => steel.sessions.retrieve(id));
  const releaseRemote = deps?.releaseRemoteSession ?? releaseSteelRemoteSession;

  for (let attempt = 1; attempt <= MAX_SESSION_RETRIES; attempt++) {
    const proxySettings = buildSteelProxySettings(
      input.proxyLocation,
      dropProxyCity,
      false,
      input.proxyMode
    );
    let validationBrowser: Browser | null = null;
    try {
      // Challenge search must never bypass the provider-native auto solver, even
      // when normal sessions have it disabled for a local experiment.
      const session = (await createSession(
        buildSteelRecoveryBrowserOptions({
          proxy: proxySettings.config,
          userAgent: input.userAgent,
        })
      )) as SteelSessionResult;
      await registerInFlightSteelSession(session.id);
      const wsUrl = steelCdpUrl(session.id);
      const validation = await validateBrowserConnection(wsUrl, {
        connect: deps?.connect,
        startupProbe: steelStartupProbe(session.id, retrieveSession),
      });
      validationBrowser = validation.browser;
      if (validationBrowser === null) {
        await releaseRemote(session.id).catch(() => {});
        lastError = new Error(
          `Steel recovery candidate ${session.id} failed CDP validation: ${validation.failure}`
        );
        if (attempt < MAX_SESSION_RETRIES) {
          await sleepBeforeSteelRetry(attempt);
        }
        continue;
      }
      await installCaptchaSolveIndicator(validationBrowser);
      return {
        sessionId: session.id,
        debugUrl: steelDebugUrl(session.debugUrl),
        wsUrl,
        proxySource: session.proxySource ?? proxySettings.source,
        proxyLocation: input.proxyLocation,
        profileId: null,
        profileSource: 'challenge_candidate_ephemeral',
        validationBrowser,
      };
    } catch (error) {
      if (validationBrowser !== null && typeof validationBrowser.close === 'function') {
        await validationBrowser.close().catch(() => {});
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        input.proxyMode === 'managed' &&
        !dropProxyCity &&
        isInvalidSteelProxyConfiguration(error)
      ) {
        dropProxyCity = true;
        rememberRejectedProxyCity(input.proxyLocation);
        log.info(
          '  🌎 Dropping unsupported proxy city on recovery candidate; retrying with country+state only'
        );
      }
      if (attempt < MAX_SESSION_RETRIES) {
        await sleepBeforeSteelRetry(attempt);
        continue;
      }
    }
  }

  throw new Error(
    `Failed to create Steel recovery session after ${MAX_SESSION_RETRIES} attempts: ${lastError?.message}`
  );
}
