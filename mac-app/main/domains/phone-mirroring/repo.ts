/**
 * Repo layer for phone-mirroring: every system and network boundary.
 *
 *   - macOS version, iPhone Mirroring.app presence, `pgrep` for its process
 *   - Screen Recording permission (systemPreferences) and the window list /
 *     window thumbnail (desktopCapturer, ScreenCaptureKit-backed)
 *   - Hardware UUID (`ioreg`) and Mac name (`scutil`)
 *   - Backend calls: register presence, long-poll stream demand, upload frame
 *
 * The service layer never touches `child_process`, `fs`, `os`, Electron or
 * `fetch` directly; blackbox tests stub exactly these seams.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { desktopCapturer, systemPreferences } from 'electron';
import { config } from '../../base/config';
import {
  IPHONE_MIRRORING_APP_PATH,
  IPHONE_MIRRORING_PROCESS,
  IPHONE_MIRRORING_WINDOW_TITLE,
  PROBE_TIMEOUT_MS,
} from './config';
import type {
  CapturedFrame,
  PhoneRegistration,
  RegisterResponse,
  ScreenRecordingAccess,
  StreamDemand,
} from './types';

// ---------------------------------------------------------------------------
// Local probes
// ---------------------------------------------------------------------------

export function platformInfo(): { platform: string; darwinMajor: number } {
  const major = Number.parseInt(os.release().split('.')[0] ?? '', 10);
  return { platform: os.platform(), darwinMajor: Number.isFinite(major) ? major : 0 };
}

export function mirroringAppInstalled(): boolean {
  return fs.existsSync(IPHONE_MIRRORING_APP_PATH);
}

/** `pgrep -x` exits 0 when a process with exactly this name runs. */
export function mirroringProcessRunning(): boolean {
  try {
    execFileSync('pgrep', ['-x', IPHONE_MIRRORING_PROCESS], {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export function screenRecordingAccess(): ScreenRecordingAccess {
  try {
    const status = systemPreferences.getMediaAccessStatus('screen');
    return ['granted', 'denied', 'not-determined', 'restricted'].includes(status)
      ? (status as ScreenRecordingAccess)
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function mirroringSource(width: number, height: number) {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  return sources.find((source) => source.name === IPHONE_MIRRORING_WINDOW_TITLE) ?? null;
}

/**
 * Whether the window server lists the iPhone Mirroring window. Only call
 * with Screen Recording granted: without it macOS hides other apps' window
 * titles, and the first call would raise the system permission prompt.
 */
export async function mirroringWindowVisible(): Promise<boolean> {
  return (await mirroringSource(0, 0)) !== null;
}

/** JPEG of the mirrored phone, scaled to fit `maxWidth` x `maxHeight`. */
export async function captureMirroringWindow(
  maxWidth: number,
  maxHeight: number,
  jpegQuality: number
): Promise<CapturedFrame | null> {
  const source = await mirroringSource(maxWidth, maxHeight);
  if (source === null || source.thumbnail.isEmpty()) return null;
  const size = source.thumbnail.getSize();
  return { bytes: source.thumbnail.toJPEG(jpegQuality), width: size.width, height: size.height };
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

async function expectOk(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(`${label} failed: ${response.status} ${body?.error ?? ''}`.trim());
}

export async function postRegistration(
  accessToken: string,
  registration: PhoneRegistration
): Promise<RegisterResponse> {
  const response = await fetch(`${config.apiUrl}/api/phones/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(registration),
  });
  await expectOk(response, 'Phone register');
  return (await response.json()) as RegisterResponse;
}

export async function fetchStreamDemand(
  accessToken: string,
  phoneId: string,
  waitMs: number,
  signal?: AbortSignal
): Promise<StreamDemand> {
  const response = await fetch(
    `${config.apiUrl}/api/phones/${encodeURIComponent(phoneId)}/stream-demand?waitMs=${waitMs}`,
    { headers: { Authorization: `Bearer ${accessToken}` }, signal }
  );
  await expectOk(response, 'Phone stream demand');
  return (await response.json()) as StreamDemand;
}

export async function uploadFrame(
  accessToken: string,
  phoneId: string,
  frame: CapturedFrame
): Promise<{ seq: number; stream: StreamDemand }> {
  const response = await fetch(
    `${config.apiUrl}/api/phones/${encodeURIComponent(phoneId)}/frame/upload`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'image/jpeg',
        'X-Phone-Frame-Width': String(frame.width),
        'X-Phone-Frame-Height': String(frame.height),
      },
      body: new Uint8Array(frame.bytes),
    }
  );
  await expectOk(response, 'Phone frame upload');
  return (await response.json()) as { seq: number; stream: StreamDemand };
}
