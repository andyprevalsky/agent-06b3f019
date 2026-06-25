/**
 * Credential Exchange activity bridge.
 *
 * Apple Passwords sends imports as an NSUserActivity of type
 * ASCredentialExchangeActivity. Electron's built-in continue-activity event is
 * Handoff-oriented and did not fire for the same-machine Passwords export flow,
 * so a small native bridge captures the NSApplicationDelegate callback and
 * writes the activity payload here.
 *
 * State machine:
 *   install native delegate proxy -> native writes activity JSON
 *     -> watch/read JSON -> extract ASCredentialImportToken -> import token once
 *     -> missing token / native addon missing -> log and keep app running
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { app } from 'electron';
import { logConsole, logConsoleError } from '../../base/logger';

interface ActivityPayload {
  activityType?: string;
  timestamp?: number;
  userInfo?: unknown;
  webpageURL?: string;
}

export interface CredentialExchangeBridge {
  activityPath: string;
  processActivityPayload: (payload: ActivityPayload) => void;
}

type TokenHandler = (token: string) => void;

let refreshNativeBridge: ((reason: string) => void) | null = null;
const requireNative = createRequire(__filename);

export function refreshCredentialExchangeActivityBridge(reason = 'manual'): void {
  refreshNativeBridge?.(reason);
}

function nativeBridgePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'rose-user-activity-bridge.node')
    : path.join(app.getAppPath(), 'dist', 'native', 'rose-user-activity-bridge.node');
}

function credentialExchangeActivityPath(): string {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'credential-exchange-activity.json');
  }

  const appPathHash = Buffer.from(app.getAppPath()).toString('hex').slice(0, 24);
  return path.join(
    app.getPath('temp'),
    `rose-dev-${appPathHash}-credential-exchange-activity.json`
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function findUuid(value: unknown, seen = new Set<unknown>()): string | null {
  if (typeof value === 'string') {
    return isUuid(value) ? value : null;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUuid(item, seen);
      if (found !== null) return found;
    }
    return null;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'ASCredentialImportToken' && typeof nested === 'string' && isUuid(nested)) {
      return nested;
    }
    const found = findUuid(nested, seen);
    if (found !== null) return found;
  }
  return null;
}

export function extractImportTokenFromActivityPayload(payload: ActivityPayload): string | null {
  return findUuid(payload.userInfo ?? payload);
}

export function installCredentialExchangeActivityBridge(
  onImportToken: TokenHandler
): CredentialExchangeBridge {
  const activityPath = credentialExchangeActivityPath();
  const bridgeStartedAt = Date.now();
  let lastToken: string | null = null;
  let lastMtime = 0;
  let nativeInstall: {
    install?: (outputPath: string) => boolean;
  } | null = null;
  let lastInstallLogAt = 0;

  function processActivityPayload(payload: ActivityPayload): void {
    const token = extractImportTokenFromActivityPayload(payload);
    if (token === null) {
      logConsole(
        'PasskeyImport',
        `credential exchange activity missing import token keys=${Object.keys((payload.userInfo ?? {}) as Record<string, unknown>).join(',')}`
      );
      return;
    }
    if (token === lastToken) {
      return;
    }
    lastToken = token;
    logConsole('PasskeyImport', `credential exchange native bridge received token=${token}`);
    onImportToken(token);
  }

  function readActivityFile(): void {
    try {
      const stat = fs.statSync(activityPath);
      if (stat.mtimeMs < bridgeStartedAt) {
        lastMtime = stat.mtimeMs;
        return;
      }
      if (stat.mtimeMs === lastMtime) {
        return;
      }
      lastMtime = stat.mtimeMs;
      processActivityPayload(JSON.parse(fs.readFileSync(activityPath, 'utf8')) as ActivityPayload);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logConsoleError('PasskeyImport', 'failed to read credential exchange activity', error);
      }
    }
  }

  function installNativeBridge(reason: string): void {
    try {
      if (nativeInstall === null) {
        nativeInstall = requireNative(nativeBridgePath()) as {
          install?: (outputPath: string) => boolean;
        };
      }
      if (nativeInstall.install?.(activityPath) !== true) {
        throw new Error('native activity bridge did not attach to NSApplication delegate');
      }
      const now = Date.now();
      if (reason !== 'interval' || now - lastInstallLogAt > 60000) {
        lastInstallLogAt = now;
        logConsole(
          'PasskeyImport',
          `installed credential exchange native bridge reason=${reason} path=${activityPath}`
        );
      }
    } catch (error) {
      logConsoleError('PasskeyImport', 'credential exchange native bridge unavailable', error);
    }
  }

  refreshNativeBridge = installNativeBridge;
  installNativeBridge('module-load');
  void app.whenReady().then(() => {
    installNativeBridge('when-ready');
    setTimeout(() => installNativeBridge('post-ready'), 1000);
  });
  app.on('activate', () => installNativeBridge('activate'));
  const reinstallInterval = setInterval(() => installNativeBridge('interval'), 30000);
  reinstallInterval.unref();

  readActivityFile();
  const interval = setInterval(readActivityFile, 500);
  interval.unref();

  return { activityPath, processActivityPayload };
}
