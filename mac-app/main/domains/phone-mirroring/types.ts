/**
 * Types for the phone-mirroring domain.
 *
 * The user's iPhone appears on this Mac through macOS iPhone Mirroring
 * (macOS 15+). This domain reports whether that phone is reachable, keeps the
 * backend's PhoneDevice presence fresh, and relays the mirrored screen while
 * someone is watching it in Rose.
 */

/** What this Mac can see of iPhone Mirroring right now. */
export interface MirroringStatus {
  /** macOS 15 (Darwin 24) or newer. */
  supported: boolean;
  /** /System/Applications/iPhone Mirroring.app exists. */
  installed: boolean;
  /** The iPhone Mirroring process is running. */
  running: boolean;
  /** Its window is listed by the window server (needs Screen Recording). */
  windowVisible: boolean;
  /** Screen Recording permission state for Rose. */
  screenRecording: ScreenRecordingAccess;
  /** The phone is shown and can be operated (Phase 1: running + window). */
  connected: boolean;
}

export type ScreenRecordingAccess =
  'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

/** POST /api/phones/register body. */
export interface PhoneRegistration {
  macDeviceId: string;
  name: string;
  model: string | null;
  kind: 'iphone_mirroring';
  online: boolean;
}

/** Backend demand for screen frames (bounded by the backend). */
export interface StreamDemand {
  requested: boolean;
  maxFps: number;
  maxWidth: number;
  jpegQuality: number;
}

/** POST /api/phones/register response (only the fields this domain reads). */
export interface RegisterResponse {
  phone: { id: string; online: boolean };
  stream: StreamDemand;
}

/** One encoded frame of the iPhone Mirroring window. */
export interface CapturedFrame {
  bytes: Buffer;
  width: number;
  height: number;
}

/** Bearer session for this Mac's own account (never an impersonated one). */
export interface PhoneSession {
  access_token: string;
}

/** Outcome of one presence cycle (what the runtime loop does next). */
export type PresenceOutcome =
  | { kind: 'signed-out' }
  | { kind: 'unavailable'; status: MirroringStatus }
  | { kind: 'registered'; phoneId: string; status: MirroringStatus; stream: StreamDemand }
  | { kind: 'error'; message: string };
