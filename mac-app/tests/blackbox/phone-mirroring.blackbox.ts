/**
 * Blackbox tests for the `phone-mirroring` domain (the user's iPhone shown on
 * this Mac through macOS iPhone Mirroring).
 *
 * Entry: main/domains/phone-mirroring/runtime.ts (+ service.ts orchestration)
 * Type:  main-service
 *
 * Boundaries stubbed: `os` (platform / Darwin release / hostname), `fs`
 * (iPhone Mirroring.app), `child_process` (`pgrep`, `ioreg`, `scutil`),
 * Electron `systemPreferences` + `desktopCapturer`, and `fetch` to the backend.
 *
 * Invariants:
 *   - detection: macOS 15+ only; app, process, Screen Recording permission and
 *     the window decide `connected`; the window list is never queried without
 *     Screen Recording (that would raise the system prompt every heartbeat)
 *   - identity: the Mac id is a salted hash of IOPlatformUUID, never the UUID
 *   - presence: nothing is sent until mirroring runs; a connected phone
 *     heartbeats POST /api/phones/register with this Mac's own bearer token;
 *     going offline is reported exactly once; signed-out and impersonated
 *     sessions send nothing
 *   - relay: frames are captured only while the backend reports a viewer, at
 *     no more than the client fps/width ceilings, and stop when it does not
 *   - runtime: start() is a no-op off macOS 15+, stop() ends the loop
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearFetchCaptures,
  fetchCaptures,
  installFetchCapture,
  type MockResponder,
} from './fetch-capture';
import type { AuthSession } from '../../shared/types/ipc';

const env = vi.hoisted(() => ({
  platform: 'darwin',
  release: '24.1.0',
  hostname: 'andys-mbp.local',
  appInstalled: true,
  processRunning: true,
  screenAccess: 'granted' as string,
  windowPresent: true,
  hardwareUuid: 'ABCDEF01-2345-6789-ABCD-EF0123456789' as string | null,
  computerName: "Andy's MacBook Pro",
  execCalls: [] as string[],
  getSourcesCalls: [] as { types: string[]; thumbnailSize: { width: number; height: number } }[],
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = {
    ...actual,
    platform: () => env.platform as NodeJS.Platform,
    release: () => env.release,
    hostname: () => env.hostname,
  };
  return { ...mocked, default: mocked };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const existsSync = (p: unknown) =>
    p === '/System/Applications/iPhone Mirroring.app'
      ? env.appInstalled
      : actual.existsSync(p as string);
  const mocked = { ...actual, existsSync };
  return { ...mocked, default: mocked };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFileSync = (command: string, args: readonly string[] = []) => {
    env.execCalls.push([command, ...args].join(' '));
    if (command === 'pgrep') {
      if (!env.processRunning) throw new Error('pgrep: no match');
      return '';
    }
    if (command === 'ioreg') {
      if (env.hardwareUuid === null) throw new Error('ioreg unavailable');
      return `+-o J316sAP  <class IOPlatformExpertDevice>\n  "IOPlatformUUID" = "${env.hardwareUuid}"\n`;
    }
    if (command === 'scutil') return `${env.computerName}\n`;
    throw new Error(`unexpected command ${command}`);
  };
  const mocked = { ...actual, execFileSync };
  return { ...mocked, default: mocked };
});

vi.mock('electron', () => ({
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => env.screenAccess),
  },
  desktopCapturer: {
    getSources: vi.fn(
      async (opts: { types: string[]; thumbnailSize: { width: number; height: number } }) => {
        env.getSourcesCalls.push(opts);
        const { width } = opts.thumbnailSize;
        const scaledWidth = Math.min(width, 460);
        const thumbnail = {
          isEmpty: () => width === 0,
          getSize: () => ({ width: scaledWidth, height: Math.round(scaledWidth * 2.17) }),
          toJPEG: (quality: number) => Buffer.from([0xff, 0xd8, 0xff, quality]),
        };
        return [
          { id: 'window:1:0', name: 'Finder', thumbnail },
          ...(env.windowPresent
            ? [{ id: 'window:42:0', name: 'iPhone Mirroring', thumbnail }]
            : []),
        ];
      }
    ),
  },
}));

vi.mock('../../main/base/config', () => ({
  config: { apiUrl: 'https://backend.test', isDev: true },
}));

vi.mock('../../main/base/logger', () => ({
  logConsole: vi.fn(),
  logConsoleError: vi.fn(),
}));

vi.mock('../../main/services/auth', () => ({
  AuthService: { getSession: vi.fn<() => Promise<AuthSession | null>>() },
}));

import { createHash } from 'crypto';
import { AuthService } from '../../main/services/auth';
import { PhoneMirroring } from '../../main/services/phoneMirroring';
import * as service from '../../main/domains/phone-mirroring/service';

const SESSION: AuthSession = {
  access_token: 'mac-own-access-token',
  refresh_token: 'refresh',
  expires_at: Date.now() + 60 * 60 * 1000,
  user: { id: 'user-1' },
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const IMPERSONATED: AuthSession = {
  ...SESSION,
  access_token: `${encode({ alg: 'HS256' })}.${encode({ sub: 'target', act: { sub: 'operator' } })}.sig`,
};

const PHONE_ID = '7b0c8f8e-3a8f-4e0e-9a51-0d6c7a8f1b2c';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const demand = (requested: boolean, extra: Record<string, number> = {}) => ({
  requested,
  maxFps: 2,
  maxWidth: 480,
  jpegQuality: 60,
  ...extra,
});
const registerOk: MockResponder = () =>
  json({ phone: { id: PHONE_ID, online: true }, stream: demand(false) });

function resetEnv(): void {
  Object.assign(env, {
    platform: 'darwin',
    release: '24.1.0',
    hostname: 'andys-mbp.local',
    appInstalled: true,
    processRunning: true,
    screenAccess: 'granted',
    windowPresent: true,
    hardwareUuid: 'ABCDEF01-2345-6789-ABCD-EF0123456789',
    computerName: "Andy's MacBook Pro",
  });
  env.execCalls.length = 0;
  env.getSourcesCalls.length = 0;
}

describe('phone-mirroring blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    resetEnv();
    clearFetchCaptures();
    service.resetPhoneMirroringStateForTests();
    vi.mocked(AuthService.getSession).mockReset();
    vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
  });

  afterEach(() => {
    PhoneMirroring.stop();
    restoreFetch?.();
    restoreFetch = null;
  });

  describe('detection', () => {
    it('is unsupported off macOS and before macOS 15, without probing anything', async () => {
      env.platform = 'linux';
      expect(await service.detectMirroring()).toMatchObject({ supported: false, connected: false });
      env.platform = 'darwin';
      env.release = '23.6.0';
      expect(await service.detectMirroring()).toMatchObject({ supported: false, connected: false });
      expect(env.execCalls).toEqual([]);
      expect(env.getSourcesCalls).toEqual([]);
    });

    it('reports app, process and window states on macOS 15+', async () => {
      env.appInstalled = false;
      expect(await service.detectMirroring()).toMatchObject({
        supported: true,
        installed: false,
        running: false,
        connected: false,
      });
      env.appInstalled = true;
      env.processRunning = false;
      expect(await service.detectMirroring()).toMatchObject({ installed: true, running: false });
      env.processRunning = true;
      env.windowPresent = false;
      expect(await service.detectMirroring()).toMatchObject({
        running: true,
        windowVisible: false,
        connected: false,
      });
      env.windowPresent = true;
      expect(await service.detectMirroring()).toEqual({
        supported: true,
        installed: true,
        running: true,
        windowVisible: true,
        screenRecording: 'granted',
        connected: true,
      });
      expect(env.execCalls).toContain('pgrep -x iPhone Mirroring');
    });

    it('never lists windows without Screen Recording (no repeated system prompt)', async () => {
      env.screenAccess = 'not-determined';
      const status = await service.detectMirroring();
      expect(status).toMatchObject({ running: true, screenRecording: 'not-determined' });
      expect(status.connected).toBe(false);
      expect(env.getSourcesCalls).toEqual([]);
    });
  });

  describe('identity', () => {
    it('sends a salted hash of IOPlatformUUID, never the UUID itself', () => {
      const id = service.macDeviceId();
      const expected = createHash('sha256')
        .update('rose-mac-device-v1\0ABCDEF01-2345-6789-ABCD-EF0123456789')
        .digest('hex')
        .slice(0, 32);
      expect(id).toBe(expected);
      expect(id).not.toContain('ABCDEF01');
      expect(service.macDeviceId()).toBe(id);
    });

    it('is the shared per-Mac identity (one id per Mac across features)', async () => {
      const identity = await import('../../main/services/deviceIdentity');
      expect(service.macDeviceId()).toBe(identity.macDeviceId());
    });

    it('falls back to the Mac name when ioreg is unavailable', () => {
      env.hardwareUuid = null;
      expect(service.macDeviceId()).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('presence', () => {
    it('registers a connected phone with the Mac bearer token', async () => {
      restoreFetch = installFetchCapture({ '/api/phones/register': registerOk });
      const outcome = await service.runPresenceCycle();
      expect(outcome).toMatchObject({ kind: 'registered', phoneId: PHONE_ID });
      expect(fetchCaptures).toHaveLength(1);
      const [call] = fetchCaptures;
      expect(call.method).toBe('POST');
      expect(call.url).toBe('https://backend.test/api/phones/register');
      expect(call.headers.authorization).toBe('Bearer mac-own-access-token');
      expect(JSON.parse(call.body ?? '{}')).toEqual({
        macDeviceId: service.macDeviceId(),
        name: "iPhone on Andy's MacBook Pro",
        model: null,
        kind: 'iphone_mirroring',
        online: true,
      });
    });

    it('sends nothing until iPhone Mirroring runs', async () => {
      restoreFetch = installFetchCapture({ '/api/phones/register': registerOk });
      env.processRunning = false;
      expect((await service.runPresenceCycle()).kind).toBe('unavailable');
      expect((await service.runPresenceCycle()).kind).toBe('unavailable');
      expect(fetchCaptures).toHaveLength(0);
    });

    it('reports going offline exactly once', async () => {
      restoreFetch = installFetchCapture({ '/api/phones/register': registerOk });
      await service.runPresenceCycle();
      await service.runPresenceCycle();
      expect(fetchCaptures).toHaveLength(2);
      env.processRunning = false;
      expect((await service.runPresenceCycle()).kind).toBe('unavailable');
      expect((await service.runPresenceCycle()).kind).toBe('unavailable');
      expect(fetchCaptures).toHaveLength(3);
      expect(JSON.parse(fetchCaptures[2].body ?? '{}').online).toBe(false);
    });

    it('registers a running but unusable phone once as offline', async () => {
      restoreFetch = installFetchCapture({ '/api/phones/register': registerOk });
      env.screenAccess = 'denied';
      await service.runPresenceCycle();
      await service.runPresenceCycle();
      expect(fetchCaptures).toHaveLength(1);
      expect(JSON.parse(fetchCaptures[0].body ?? '{}').online).toBe(false);
    });

    it('sends nothing when signed out or impersonating another account', async () => {
      restoreFetch = installFetchCapture({ '/api/phones/register': registerOk });
      vi.mocked(AuthService.getSession).mockResolvedValue(null);
      expect(await service.runPresenceCycle()).toEqual({ kind: 'signed-out' });
      vi.mocked(AuthService.getSession).mockResolvedValue(IMPERSONATED);
      expect(await service.runPresenceCycle()).toEqual({ kind: 'signed-out' });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('surfaces a backend failure as an error outcome', async () => {
      restoreFetch = installFetchCapture({
        '/api/phones/register': () => json({ error: 'boom' }, 500),
      });
      expect(await service.runPresenceCycle()).toEqual({
        kind: 'error',
        message: 'Phone register failed: 500 boom',
      });
    });
  });

  describe('screen relay', () => {
    it('long-polls the backend for viewer demand', async () => {
      restoreFetch = installFetchCapture({ '/stream-demand': () => json(demand(true)) });
      const result = await service.waitForViewer(PHONE_ID, 20_000);
      expect(result?.requested).toBe(true);
      expect(fetchCaptures[0].url).toBe(
        `https://backend.test/api/phones/${PHONE_ID}/stream-demand?waitMs=20000`
      );
      expect(fetchCaptures[0].headers.authorization).toBe('Bearer mac-own-access-token');
    });

    it('uploads bounded frames only while a viewer is watching', async () => {
      const uploads: { bytes: Buffer; type: string | null; width: string | null }[] = [];
      let remainingWithViewer = 2;
      restoreFetch = installFetchCapture({
        '/frame/upload': async (req) => {
          uploads.push({
            bytes: Buffer.from(await req.arrayBuffer()),
            type: req.headers.get('content-type'),
            width: req.headers.get('x-phone-frame-width'),
          });
          remainingWithViewer--;
          return json({
            seq: uploads.length,
            stream: demand(remainingWithViewer > 0, { maxFps: 30 }),
          });
        },
      });
      const sleeps: number[] = [];
      const count = await service.streamWhileRequested(
        PHONE_ID,
        demand(true, { maxFps: 30, maxWidth: 4000, jpegQuality: 100 }),
        { isActive: () => true, sleep: async (ms) => void sleeps.push(ms), now: () => 0 }
      );
      expect(count).toBe(2);
      expect(uploads).toHaveLength(2);
      expect(uploads[0].type).toBe('image/jpeg');
      expect(uploads[0].bytes.equals(Buffer.from([0xff, 0xd8, 0xff, 80]))).toBe(true);
      expect(uploads[0].width).toBe('460');
      // 30 fps requested, 2 fps ceiling: one 500ms gap between the two frames.
      expect(sleeps).toEqual([500]);
      const captures = env.getSourcesCalls.filter((c) => c.thumbnailSize.width > 0);
      expect(captures.every((c) => c.thumbnailSize.width === 480)).toBe(true);
      expect(captures[0].thumbnailSize.height).toBe(1056);
      expect(
        fetchCaptures.every((c) => c.url.endsWith(`/api/phones/${PHONE_ID}/frame/upload`))
      ).toBe(true);
    });

    it('captures nothing when no viewer is waiting, and stops if the window disappears', async () => {
      restoreFetch = installFetchCapture({
        '/frame/upload': () => json({ seq: 1, stream: demand(true) }),
      });
      const options = { isActive: () => true, sleep: async () => {}, now: () => 0 };
      expect(await service.streamWhileRequested(PHONE_ID, demand(false), options)).toBe(0);
      env.windowPresent = false;
      expect(await service.streamWhileRequested(PHONE_ID, demand(true), options)).toBe(0);
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  describe('runtime', () => {
    it('does not start off macOS 15+', () => {
      env.platform = 'linux';
      expect(PhoneMirroring.start()).toBe(false);
      expect(PhoneMirroring.isActive()).toBe(false);
    });

    it('starts the presence loop on macOS 15+ and stop() ends it', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(null);
      expect(PhoneMirroring.start()).toBe(true);
      expect(PhoneMirroring.start()).toBe(true);
      expect(PhoneMirroring.isActive()).toBe(true);
      await vi.waitFor(() => expect(vi.mocked(AuthService.getSession)).toHaveBeenCalled());
      PhoneMirroring.stop();
      expect(PhoneMirroring.isActive()).toBe(false);
      const calls = vi.mocked(AuthService.getSession).mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(vi.mocked(AuthService.getSession).mock.calls.length).toBe(calls);
    });
  });
});
