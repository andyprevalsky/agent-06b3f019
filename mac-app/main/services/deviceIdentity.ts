/**
 * One identity per Mac, shared by every feature that names "this Mac" to the
 * backend: local code-agent devices (`LocalDevice.device_id`, the
 * `X-Rose-Device-Id` header), attached phones (`PhoneDevice.macDeviceId`) and
 * per-Mac integration accounts such as iMessage.
 *
 *   macDeviceId()   salted sha256 of IOPlatformUUID (never the UUID itself);
 *                   survives app reinstall. Falls back to the Mac's name.
 *   macDeviceName() "Andy's MacBook Pro" (scutil ComputerName), else hostname.
 */
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import os from 'os';

const MAC_DEVICE_ID_SALT = 'rose-mac-device-v1';
const PROBE_TIMEOUT_MS = 3_000;

let cachedMacDeviceId: string | null = null;

/** IOPlatformUUID, or null when `ioreg` is unavailable. */
function readHardwareUuid(): string | null {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    });
    return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The Mac's user-visible name ("Andy's MacBook Pro"), falling back to the hostname. */
export function macDeviceName(): string {
  try {
    const name = execFileSync('scutil', ['--get', 'ComputerName'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    }).trim();
    if (name !== '') return name;
  } catch {
    // not macOS or scutil unavailable
  }
  return os.hostname().replace(/\.local$/, '');
}

/** Stable per-Mac id: 32 hex chars, a salted hash of the hardware UUID. */
export function macDeviceId(): string {
  if (cachedMacDeviceId !== null) return cachedMacDeviceId;
  const basis = readHardwareUuid() ?? `host:${macDeviceName()}`;
  cachedMacDeviceId = crypto
    .createHash('sha256')
    .update(`${MAC_DEVICE_ID_SALT}\0${basis}`)
    .digest('hex')
    .slice(0, 32);
  return cachedMacDeviceId;
}

export function resetDeviceIdentityForTests(): void {
  cachedMacDeviceId = null;
}
