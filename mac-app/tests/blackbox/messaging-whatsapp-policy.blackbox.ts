/**
 * messaging-whatsapp: connection-close policy + Baileys loader blackbox
 *
 * Surface under test:
 *   - main/domains/messaging-whatsapp/policy.ts        (pure close-decision policy)
 *   - main/domains/messaging-whatsapp/client-loader.ts (memoized ESM loader + diagnostics logger)
 *
 * Both are deliberately dependency-free boundaries: the policy decides whether a
 * socket close wipes credentials or re-dials, and the loader owns the one place
 * Baileys' ESM-only module is pulled into the CommonJS main build. The policy is
 * the regression guard for the pairing bug where a 515 `restartRequired` — the
 * handshake Baileys emits right after a SUCCESSFUL pairing — was treated as a
 * dead session, wiping the credentials that had just been persisted and bouncing
 * the user back to a fresh QR forever.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  WHATSAPP_STATUS_LOGGED_OUT,
  WHATSAPP_STATUS_RESTART_REQUIRED,
} from '../../main/domains/messaging-whatsapp/config';
import { decideConnectionClose } from '../../main/domains/messaging-whatsapp/policy';

describe('messaging-whatsapp policy: decideConnectionClose', () => {
  it('401 loggedOut is the ONLY status that clears credentials', () => {
    expect(decideConnectionClose(WHATSAPP_STATUS_LOGGED_OUT, 0, 3)).toEqual({
      clearCredentials: true,
      reconnect: false,
    });
  });

  it('515 restartRequired keeps credentials and reconnects while under the attempt ceiling', () => {
    expect(decideConnectionClose(WHATSAPP_STATUS_RESTART_REQUIRED, 0, 3)).toEqual({
      clearCredentials: false,
      reconnect: true,
    });
    expect(decideConnectionClose(WHATSAPP_STATUS_RESTART_REQUIRED, 2, 3)).toEqual({
      clearCredentials: false,
      reconnect: true,
    });
  });

  it('515 at/over the ceiling stops reconnecting but STILL keeps credentials', () => {
    expect(decideConnectionClose(WHATSAPP_STATUS_RESTART_REQUIRED, 3, 3)).toEqual({
      clearCredentials: false,
      reconnect: false,
    });
    expect(decideConnectionClose(WHATSAPP_STATUS_RESTART_REQUIRED, 9, 3)).toEqual({
      clearCredentials: false,
      reconnect: false,
    });
  });

  it('a zero ceiling disables reconnect without destroying the pairing', () => {
    expect(decideConnectionClose(WHATSAPP_STATUS_RESTART_REQUIRED, 0, 0)).toEqual({
      clearCredentials: false,
      reconnect: false,
    });
  });

  it('unknown and undefined statuses are inert: no wipe, no re-dial', () => {
    for (const status of [undefined, 0, 408, 500, 428]) {
      expect(decideConnectionClose(status, 0, 3)).toEqual({
        clearCredentials: false,
        reconnect: false,
      });
    }
  });

  it('never clears credentials for any status other than loggedOut (exhaustive sweep)', () => {
    for (let status = 400; status <= 599; status += 1) {
      const decision = decideConnectionClose(status, 0, 3);
      expect(decision.clearCredentials).toBe(status === WHATSAPP_STATUS_LOGGED_OUT);
    }
  });
});

describe('messaging-whatsapp client-loader', () => {
  let tmpDir: string;
  const originalDebugLog = process.env.WHATSAPP_DEBUG_LOG;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-loader-'));
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDebugLog === undefined) delete process.env.WHATSAPP_DEBUG_LOG;
    else process.env.WHATSAPP_DEBUG_LOG = originalDebugLog;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('defaults to a silent logger when WHATSAPP_DEBUG_LOG is unset or empty', async () => {
    for (const value of [undefined, '']) {
      vi.resetModules();
      if (value === undefined) delete process.env.WHATSAPP_DEBUG_LOG;
      else process.env.WHATSAPP_DEBUG_LOG = value;

      const { silentBaileysLogger } =
        await import('../../main/domains/messaging-whatsapp/client-loader');
      expect(silentBaileysLogger.level).toBe('silent');
      // A silent logger must write nothing anywhere and never throw.
      expect(() => silentBaileysLogger.error('boom', { a: 1 })).not.toThrow();
      expect(silentBaileysLogger.child()).toBe(silentBaileysLogger);
    }
  });

  it('appends every level to WHATSAPP_DEBUG_LOG when the opt-in path is set', async () => {
    const logPath = path.join(tmpDir, 'wa-debug.log');
    process.env.WHATSAPP_DEBUG_LOG = logPath;

    const { silentBaileysLogger } =
      await import('../../main/domains/messaging-whatsapp/client-loader');
    expect(silentBaileysLogger.level).toBe('trace');
    expect(silentBaileysLogger.child()).toBe(silentBaileysLogger);

    silentBaileysLogger.trace('t-line');
    silentBaileysLogger.debug('d-line');
    silentBaileysLogger.info('i-line');
    silentBaileysLogger.warn('w-line');
    silentBaileysLogger.error('e-line');
    silentBaileysLogger.fatal('f-line');

    const written = fs.readFileSync(logPath, 'utf8');
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      expect(written).toContain(`[${level}]`);
    }
    expect(written).toContain('t-line');
    expect(written).toContain('f-line');
  });

  it('serializes objects, falls back to String() on circular payloads, joins mixed args', async () => {
    const logPath = path.join(tmpDir, 'wa-serialize.log');
    process.env.WHATSAPP_DEBUG_LOG = logPath;

    const { silentBaileysLogger } =
      await import('../../main/domains/messaging-whatsapp/client-loader');

    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    silentBaileysLogger.info('prefix', { code: 515 }, circular);

    const written = fs.readFileSync(logPath, 'utf8');
    expect(written).toContain('prefix');
    expect(written).toContain('{"code":515}');
    // JSON.stringify throws on the cycle → String(obj) fallback, not a crash.
    expect(written).toContain('[object Object]');
  });

  it('a failing appendFileSync never breaks the connection', async () => {
    process.env.WHATSAPP_DEBUG_LOG = path.join(tmpDir, 'nested', 'missing-dir', 'wa.log');

    const { silentBaileysLogger } =
      await import('../../main/domains/messaging-whatsapp/client-loader');

    // The directory does not exist, so appendFileSync throws internally.
    expect(() => silentBaileysLogger.error('unwritable')).not.toThrow();
  });

  it('keeps the ESM escape hatch: the Baileys import must survive CJS transpilation', () => {
    // Baileys is ESM-only. Under `"module": "commonjs"` TypeScript rewrites a
    // plain `import()` into `require()`, which throws ERR_REQUIRE_ESM at runtime
    // in the packaged Electron main process — a failure no unit test can catch
    // because the transpile only happens in the real build. The Function
    // constructor is what keeps the dynamic import intact, so guard it here.
    // (The loader itself cannot be *invoked* under vitest: its transform does
    // not provide a dynamic-import callback to `new Function`.)
    const source = fs.readFileSync(
      path.join(__dirname, '../../main/domains/messaging-whatsapp/client-loader.ts'),
      'utf8'
    );
    expect(source).toMatch(/new Function\(\s*'modulePath',\s*'return import\(modulePath\)'\s*\)/);
    // `import type` is erased at compile time and is safe; a VALUE import is not.
    expect(source).not.toMatch(/^\s*import\s+(?!type\s)[^;]*from\s+'@whiskeysockets\/baileys'/m);
    // Memoization guard: the cached instance is only ever cleared through the
    // exported reset, so a reconnect never re-imports the module.
    expect(source).toMatch(/if \(baileys === null\)/);
    expect(source).toMatch(/export function resetBaileysCache\(\): void \{\s*baileys = null;/);
  });

  it('exposes a stable loader surface', async () => {
    const loader = await import('../../main/domains/messaging-whatsapp/client-loader');
    expect(typeof loader.loadBaileys).toBe('function');
    expect(typeof loader.resetBaileysCache).toBe('function');
    // Resetting an already-empty cache is a no-op, not a throw.
    expect(() => {
      loader.resetBaileysCache();
      loader.resetBaileysCache();
    }).not.toThrow();
  });
});
