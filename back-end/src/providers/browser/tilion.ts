/**
 * Tilion Cloud browser sessions, exposed through the same CDP contract as
 * Steel, Kernel and Browser Use. See docs/plans/active/tilion-browser-provider.md.
 *
 * CONTRACT STUB: lane A1 owns this file and replaces every body. The exported
 * names and signatures are the cross-lane contract; change them only through
 * the parent coordinator.
 */
import type { Browser } from 'playwright';
import { DEFAULT_GEOLOCATION, type ProxyGeoLocation } from '../geoip';
import type { KernelProxyType } from './kernelProxy';
import type {
  BrowserFileInfo,
  BrowserProviderName,
  BrowserProviderResumeSession,
  BrowserProviderSession,
  BrowserSessionHealth,
} from './types';
import type { BrowserCaptchaTelemetry } from './captchaTelemetry';

function notImplemented(name: string): never {
  throw new Error(`Tilion provider ${name} is not implemented yet`);
}

export type TilionReplacementSession = BrowserProviderResumeSession & {
  previousSessionId: string;
  previousProvider: BrowserProviderName;
};

export async function createTilionSessionWithContext(
  _contextId: string,
  _agentId: string,
  _location: ProxyGeoLocation = DEFAULT_GEOLOCATION,
  _startUrl?: string,
  _options?: { keepValidationConnection?: boolean; taskId?: string }
): Promise<BrowserProviderSession> {
  return notImplemented('createTilionSessionWithContext');
}

export async function createTilionRecoverySession(_location: ProxyGeoLocation): Promise<{
  sessionId: string;
  debugUrl: string;
  wsUrl: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  profileId: null;
  profileSource: string;
  validationBrowser: Browser | null;
}> {
  return notImplemented('createTilionRecoverySession');
}

export async function closeTilionSession(
  _sessionId: string,
  _pause = false,
  _currentUrl?: string
): Promise<void> {
  notImplemented('closeTilionSession');
}

/** Idempotent remote release: 204/404/410 count as released; bounded retries on 429/5xx. */
export async function releaseTilionRemoteSession(_sessionId: string): Promise<void> {
  notImplemented('releaseTilionRemoteSession');
}

/** Replace the task's session (resume after pause/expiry) on Tilion, preserving browser state. */
export async function resumeTilionSession(
  _taskId: string,
  _options: { forceFreshProfile?: boolean; keepValidationConnection?: boolean } = {}
): Promise<TilionReplacementSession> {
  return notImplemented('resumeTilionSession');
}

/** Rotation step on Tilion: fresh exit of the requested proxy type, browser state preserved. */
export async function rotateTilionSession(
  _taskId: string,
  _proxyType: KernelProxyType,
  _options: { keepValidationConnection?: boolean } = {}
): Promise<TilionReplacementSession> {
  return notImplemented('rotateTilionSession');
}

export async function getTilionSessionHealth(_sessionId: string): Promise<BrowserSessionHealth> {
  return notImplemented('getTilionSessionHealth');
}

export async function getTilionCaptchaTelemetry(
  _sessionId: string
): Promise<BrowserCaptchaTelemetry> {
  return notImplemented('getTilionCaptchaTelemetry');
}

/** Fresh interactive live-view URL (mints a new view token; tokens last 1800 s). */
export async function getTilionLiveViewUrl(_sessionId: string): Promise<string> {
  return notImplemented('getTilionLiveViewUrl');
}

export async function pressTilionKeys(_sessionId: string, _keys: string[]): Promise<void> {
  notImplemented('pressTilionKeys');
}

export async function captureTilionScreenshot(_sessionId: string): Promise<Buffer> {
  return notImplemented('captureTilionScreenshot');
}

export async function listTilionSessionFiles(_sessionId: string): Promise<BrowserFileInfo[]> {
  return notImplemented('listTilionSessionFiles');
}

export async function readTilionSessionFile(_sessionId: string, _path: string): Promise<Buffer> {
  return notImplemented('readTilionSessionFile');
}

export async function uploadTilionSessionFile(
  _sessionId: string,
  _content: Buffer,
  _filename: string,
  _mimeType: string,
  _options: { directory?: string } = {}
): Promise<{ path: string; size: number }> {
  return notImplemented('uploadTilionSessionFile');
}

/** Live Tilion session ids for this API key (account-wide; never implies ownership). */
export async function listLiveTilionSessionIds(): Promise<string[]> {
  return notImplemented('listLiveTilionSessionIds');
}
