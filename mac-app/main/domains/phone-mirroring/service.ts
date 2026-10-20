/**
 * Service layer for phone-mirroring.
 *
 *   detectMirroring ──► status (macOS 15+, app, process, window, permission)
 *          │
 *   runPresenceCycle ─► POST /api/phones/register (online = connected)
 *          │                      │
 *          │              stream.requested? ──no──► long-poll stream-demand
 *          ▼                      │ yes                  (wakes on a viewer)
 *   streamWhileRequested ─► capture window → PUT frame/upload, ≤ maxFps,
 *                           until the backend reports no viewer
 *
 * Only this Mac's own (non-impersonated) session is used: an operator's Mac
 * must never attach its phone or screen to the account it is viewing.
 * Nothing is sent until iPhone Mirroring is running; a connected phone
 * heartbeats every cycle, and going offline is reported once.
 */

import { sessionForLocalMachineData } from '../../base/impersonation';
import { logConsole } from '../../base/logger';
import { AuthService } from '../../services/auth';
import {
  macDeviceId,
  macDeviceName,
  resetDeviceIdentityForTests,
} from '../../services/deviceIdentity';
import { getErrorMessage } from '../../../shared/utils/error';
import {
  DEFAULT_PHONE_NAME,
  JPEG_QUALITY_CEILING,
  LOG_COMPONENT,
  MAX_FPS_CEILING,
  MAX_WIDTH_CEILING,
  MIN_DARWIN_MAJOR,
  PHONE_KIND,
  THUMBNAIL_HEIGHT_RATIO,
} from './config';
import * as repo from './repo';
import type {
  MirroringStatus,
  PhoneRegistration,
  PhoneSession,
  PresenceOutcome,
  StreamDemand,
} from './types';

/**
 * The `online` value last reported to the backend in this session (null =
 * nothing reported yet). Drives "report the change once" when mirroring is
 * not connected, so an idle Mac does not heartbeat an offline phone forever.
 */
let lastReportedOnline: boolean | null = null;

/** Forget what was reported (new session / runtime stop). */
export function resetPresenceState(): void {
  lastReportedOnline = null;
}

export function resetPhoneMirroringStateForTests(): void {
  lastReportedOnline = null;
  resetDeviceIdentityForTests();
}

/**
 * Connected phones heartbeat every cycle. Otherwise post only a change: the
 * first sighting of a running-but-unusable mirroring app, or going offline.
 */
function shouldPostPresence(status: MirroringStatus): boolean {
  if (status.connected) return true;
  if (lastReportedOnline === true) return true;
  return lastReportedOnline === null && status.running;
}

/** macOS 15 (Darwin 24) or newer: the first release with iPhone Mirroring. */
export function platformSupported(): boolean {
  const { platform, darwinMajor } = repo.platformInfo();
  return platform === 'darwin' && darwinMajor >= MIN_DARWIN_MAJOR;
}

export async function detectMirroring(): Promise<MirroringStatus> {
  const supported = platformSupported();
  const installed = supported && repo.mirroringAppInstalled();
  const running = installed && repo.mirroringProcessRunning();
  const screenRecording = supported ? repo.screenRecordingAccess() : 'unknown';
  // Listing other apps' windows needs Screen Recording; asking without it
  // would raise the system prompt on every heartbeat.
  const windowVisible =
    running && screenRecording === 'granted' ? await repo.mirroringWindowVisible() : false;
  return {
    supported,
    installed,
    running,
    windowVisible,
    screenRecording,
    connected: running && windowVisible,
  };
}

/** Stable per-Mac id shared with local code devices and per-Mac integrations. */
export { macDeviceId };

export function buildRegistration(status: MirroringStatus): PhoneRegistration {
  const computer = macDeviceName().trim();
  const name = computer === '' ? DEFAULT_PHONE_NAME : `${DEFAULT_PHONE_NAME} on ${computer}`;
  return {
    macDeviceId: macDeviceId(),
    name: name.slice(0, 120),
    model: null,
    kind: PHONE_KIND,
    online: status.connected,
  };
}

/** The current session when it is safe to attach this Mac's phone to it. */
export async function localSession(): Promise<PhoneSession | null> {
  const session = sessionForLocalMachineData(await AuthService.getSession());
  if (session === null || typeof session.access_token !== 'string') return null;
  return { access_token: session.access_token };
}

/** One presence heartbeat: detect, then register (or report offline). */
export async function runPresenceCycle(): Promise<PresenceOutcome> {
  const session = await localSession();
  if (session === null) return { kind: 'signed-out' };
  const status = await detectMirroring();
  if (!shouldPostPresence(status)) return { kind: 'unavailable', status };
  try {
    const result = await repo.postRegistration(session.access_token, buildRegistration(status));
    lastReportedOnline = status.connected;
    if (!status.connected) return { kind: 'unavailable', status };
    return { kind: 'registered', phoneId: result.phone.id, status, stream: result.stream };
  } catch (error) {
    const message = getErrorMessage(error);
    logConsole(LOG_COMPONENT, `presence heartbeat failed: ${message}`);
    return { kind: 'error', message };
  }
}

/** Long-poll the backend until a viewer appears (or the wait elapses). */
export async function waitForViewer(
  phoneId: string,
  waitMs: number,
  signal?: AbortSignal
): Promise<StreamDemand | null> {
  const session = await localSession();
  if (session === null) return null;
  try {
    return await repo.fetchStreamDemand(session.access_token, phoneId, waitMs, signal);
  } catch (error) {
    if (signal?.aborted === true) return null;
    logConsole(LOG_COMPONENT, `stream-demand wait failed: ${getErrorMessage(error)}`);
    return null;
  }
}

/** Clamp the backend's demand to this client's own ceilings. */
export function boundedDemand(demand: StreamDemand): StreamDemand {
  return {
    requested: demand.requested,
    maxFps: Math.max(0.1, Math.min(demand.maxFps, MAX_FPS_CEILING)),
    maxWidth: Math.max(64, Math.min(Math.round(demand.maxWidth), MAX_WIDTH_CEILING)),
    jpegQuality: Math.max(10, Math.min(Math.round(demand.jpegQuality), JPEG_QUALITY_CEILING)),
  };
}

export interface StreamOptions {
  /** False once the runtime stops (or the session changes). */
  isActive: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Capture and upload frames while the backend reports a viewer. Returns the
 * number of frames uploaded. Never exceeds the bounded fps.
 */
export async function streamWhileRequested(
  phoneId: string,
  initial: StreamDemand,
  options: StreamOptions
): Promise<number> {
  let demand = boundedDemand(initial);
  let uploaded = 0;
  while (demand.requested && options.isActive()) {
    const startedAt = options.now();
    const session = await localSession();
    if (session === null) break;
    const frame = await repo.captureMirroringWindow(
      demand.maxWidth,
      Math.round(demand.maxWidth * THUMBNAIL_HEIGHT_RATIO),
      demand.jpegQuality
    );
    if (frame === null) break;
    try {
      const result = await repo.uploadFrame(session.access_token, phoneId, frame);
      uploaded++;
      demand = boundedDemand(result.stream);
    } catch (error) {
      logConsole(LOG_COMPONENT, `frame upload failed: ${getErrorMessage(error)}`);
      break;
    }
    const interval = 1000 / demand.maxFps;
    const elapsed = options.now() - startedAt;
    if (demand.requested && options.isActive())
      await options.sleep(Math.max(0, interval - elapsed));
  }
  return uploaded;
}
