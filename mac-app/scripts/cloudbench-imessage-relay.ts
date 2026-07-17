#!/usr/bin/env tsx
/**
 * Local macOS relay for the live cloud `message-person` benchmark.
 *
 * The benchmark backend runs inside a Fly machine, while Apple Messages can
 * only be automated from the authenticated user's Mac. The controller exposes
 * that exact backend through a run-scoped Fly proxy and starts this process.
 * This relay authenticates with the installed Rose session, exercises the
 * production IMessageSender AppleScript implementation, and reports the
 * durable queue result back to the benchmark backend.
 */

import { extractFile } from '@electron/asar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IMessageSender } from '../main/services/iMessageSender';

/** Hard cap on the pre-runRelay auto-login fetch so a stalled backend can't eat the relay's heartbeat window. */
const AUTO_LOGIN_FETCH_TIMEOUT_MS = 15_000;

export interface RelayQueueMessage {
  id: string;
  phone_number: string;
  message: string;
  agent_id: string;
  created_at: string;
  claim_token: string;
}

interface PopResponse {
  message: RelayQueueMessage | null;
}

export interface RelayOutcome<T = undefined> {
  ok: boolean;
  status: number;
  statusText: string;
  data?: T;
}

export interface RelayMarkerStore {
  has(queueId: string): boolean;
  mark(queueId: string): void;
  clear(queueId: string): void;
}

export interface RelayDependencies {
  pop(): Promise<RelayOutcome<PopResponse>>;
  report(
    queueId: string,
    result: { claim_token: string; success: boolean; error?: string }
  ): Promise<RelayOutcome>;
  send(to: string, message: string): Promise<void>;
  markers: RelayMarkerStore;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export interface RelayConfig {
  expectedPhone: string;
  expectedMessage: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface RelayReceipt {
  queueId: string;
  agentId: string;
  phoneNumber: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateExpectedMessage(message: RelayQueueMessage, config: RelayConfig): void {
  if (message.phone_number !== config.expectedPhone || message.message !== config.expectedMessage) {
    throw new Error(
      `Refusing unexpected queue item ${message.id}: expected the run-scoped benchmark recipient and body`
    );
  }
  if (!message.id || !message.agent_id || !message.claim_token) {
    throw new Error('Refusing malformed iMessage queue item');
  }
}

/** Poll until one exact benchmark message is sent and durably acknowledged. */
export async function runRelay(
  config: RelayConfig,
  dependencies: RelayDependencies
): Promise<RelayReceipt> {
  const deadline = dependencies.now() + config.timeoutMs;
  let heartbeatLogged = false;
  let lastTransportError = '';

  while (dependencies.now() < deadline) {
    const popped = await dependencies.pop();
    if (!popped.ok) {
      if (popped.status === 401 || popped.status === 403) {
        throw new Error(`Authenticated iMessage relay rejected (${popped.status})`);
      }
      lastTransportError = `${popped.status || 'network'} ${popped.statusText}`.trim();
      await dependencies.sleep(config.pollIntervalMs);
      continue;
    }

    if (!heartbeatLogged) {
      dependencies.log('bridge heartbeat established');
      heartbeatLogged = true;
    }

    const queued = popped.data?.message ?? null;
    if (queued === null) {
      await dependencies.sleep(config.pollIntervalMs);
      continue;
    }

    try {
      validateExpectedMessage(queued, config);
    } catch (error) {
      await dependencies.report(queued.id, {
        claim_token: queued.claim_token,
        success: false,
        error: errorMessage(error),
      });
      throw error;
    }

    if (!dependencies.markers.has(queued.id)) {
      try {
        await dependencies.send(queued.phone_number, queued.message);
        // Persist before ACK: if the HTTP result is lost, a later claim only
        // retries acknowledgement and never runs AppleScript twice.
        dependencies.markers.mark(queued.id);
      } catch (error) {
        const failure = errorMessage(error);
        const reported = await dependencies.report(queued.id, {
          claim_token: queued.claim_token,
          success: false,
          error: failure,
        });
        if (!reported.ok) {
          lastTransportError = `send failed and failure ACK returned ${reported.status}`;
        } else {
          lastTransportError = failure;
        }
        await dependencies.sleep(config.pollIntervalMs);
        continue;
      }
    }

    const acknowledged = await dependencies.report(queued.id, {
      claim_token: queued.claim_token,
      success: true,
    });
    if (!acknowledged.ok) {
      lastTransportError = `success ACK returned ${acknowledged.status} ${acknowledged.statusText}`;
      await dependencies.sleep(config.pollIntervalMs);
      continue;
    }

    dependencies.markers.clear(queued.id);
    dependencies.log(`delivery acknowledged queue_id=${queued.id}`);
    return {
      queueId: queued.id,
      agentId: queued.agent_id,
      phoneNumber: queued.phone_number,
    };
  }

  throw new Error(
    `Timed out waiting for confirmed benchmark iMessage${lastTransportError ? `; last error: ${lastTransportError}` : ''}`
  );
}

export interface StoredSession {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  user?: { id?: string };
}

export interface AutoLoginCredentials {
  phone: string;
  otp: string;
}

export function sessionExpiresAtMs(session: StoredSession | undefined): number {
  if (!session?.expires_at) return 0;
  return session.expires_at < 1_000_000_000_000 ? session.expires_at * 1000 : session.expires_at;
}

export function isUsableSession(
  session: StoredSession | undefined,
  expectedUserId: string
): boolean {
  return Boolean(
    session?.access_token &&
    session.user?.id === expectedUserId &&
    sessionExpiresAtMs(session) > Date.now() + 60_000
  );
}

// Mint a fresh session for the benchmark user via the backend's own OTP
// verification (POST /api/auth/verify-otp), NOT Supabase directly. The dev test
// OTP (181818) is a backend-level bypass (checkTwilioVerifyOTP auto-approves the
// test phone) — Supabase never knows it, so a direct Supabase verifyOtp is
// rejected as "Token expired or invalid". Going through the backend is the only
// path that honors the documented dev bypass, and it returns the same
// backend-signed session the app itself uses. Used only by the auto-login path
// so an unauthenticated (or expired) installed Rose app cannot block the live
// message-person benchmark.
export async function mintSessionViaBackendOtp(
  baseUrl: string,
  credentials: AutoLoginCredentials
): Promise<StoredSession> {
  // Bound the auto-login fetch so a hung/slow backend (or DNS stall) fails fast
  // instead of eating the relay's whole heartbeat window and delaying benchmark
  // startup. This runs before runRelay, so there's no other timeout guarding it.
  const response = await fetch(`${baseUrl}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: credentials.phone, token: credentials.otp }),
    signal: AbortSignal.timeout(AUTO_LOGIN_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Auto-login failed for ${credentials.phone}: verify-otp ${response.status} ${detail.slice(0, 200)}`
    );
  }
  const body = (await response.json()) as {
    session?: {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
      token_type?: string;
    };
    user?: { id?: string };
  };
  const accessToken = body.session?.access_token;
  const userId = body.user?.id;
  if (!accessToken || !userId) {
    throw new Error(`Auto-login failed for ${credentials.phone}: no session returned`);
  }
  return {
    access_token: accessToken,
    refresh_token: body.session?.refresh_token,
    expires_at: body.session?.expires_at,
    token_type: body.session?.token_type ?? 'bearer',
    user: { id: userId },
  };
}

function envValue(contents: string, key: string): string | undefined {
  const line = contents.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}=`));
  return line
    ?.slice(key.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

export async function loadInstalledRoseSession(
  expectedUserId: string,
  autoLogin?: AutoLoginCredentials,
  baseUrl?: string
): Promise<StoredSession> {
  const appPath = process.env.ROSE_APP_PATH || '/Applications/Rose.app';
  const archive = path.join(appPath, 'Contents/Resources/app.asar');
  if (!fs.existsSync(archive)) {
    throw new Error(`Installed Rose app not found at ${appPath}`);
  }
  const productionEnv = extractFile(archive, '.env.production').toString('utf8');
  const encryptionKey = envValue(productionEnv, 'ENCRYPTION_KEY');
  if (!encryptionKey) {
    throw new Error('Installed Rose app is missing its encrypted-session key');
  }

  const { default: Store } = await import('electron-store');
  // clearInvalidConfig: true — if the on-disk navi-auth store can't be decrypted
  // with the installed app's key (stale/rotated key, or a store written by a
  // differently-keyed build), electron-store would otherwise THROW on
  // construction ("Unexpected token '<binary>' ... is not valid JSON") and crash
  // the relay before auto-login can run. Clearing the invalid config instead
  // lets us fall through to auto-login, which re-mints a session and persists it
  // encrypted with the current key — self-healing the corrupt store.
  const store = new Store({
    name: 'navi-auth',
    cwd:
      process.env.ROSE_USER_DATA_DIR ||
      path.join(os.homedir(), 'Library', 'Application Support', 'Rose'),
    encryptionKey,
    clearInvalidConfig: true,
  });
  const session = store.get('session') as StoredSession | undefined;
  if (isUsableSession(session, expectedUserId)) {
    return session as StoredSession;
  }

  // No usable installed session. When benchmark auto-login credentials are
  // supplied, mint a fresh session for the expected user and persist it into
  // the same encrypted store the installed Rose app reads, so a signed-out (or
  // expired) app can no longer block the live message-person benchmark. This
  // path is gated on explicit credentials, so production relays without them
  // still fail closed with the diagnostics below.
  if (autoLogin) {
    if (!baseUrl) {
      throw new Error('Auto-login requires --base-url to reach the backend verify-otp endpoint');
    }
    const minted = await mintSessionViaBackendOtp(baseUrl, autoLogin);
    if (minted.user?.id !== expectedUserId) {
      throw new Error(
        `Auto-login session belongs to ${minted.user?.id}, expected benchmark user ${expectedUserId}`
      );
    }
    store.set('session', minted);
    return minted;
  }

  const expiresAt = sessionExpiresAtMs(session);
  if (!session?.access_token || !session.user?.id) {
    throw new Error('Installed Rose app has no authenticated session');
  }
  if (session.user.id !== expectedUserId) {
    throw new Error(
      `Installed Rose session belongs to ${session.user.id}, expected benchmark user ${expectedUserId}`
    );
  }
  if (expiresAt <= Date.now() + 60_000) {
    throw new Error('Installed Rose session is expired or expires within one minute');
  }
  return session;
}

function createFileMarkerStore(markerFile: string): RelayMarkerStore {
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  let sent = new Set<string>();
  if (fs.existsSync(markerFile)) {
    try {
      const values = JSON.parse(fs.readFileSync(markerFile, 'utf8')) as unknown;
      if (Array.isArray(values))
        sent = new Set(values.filter((value): value is string => typeof value === 'string'));
    } catch {
      throw new Error(`Invalid relay marker file: ${markerFile}`);
    }
  }
  const persist = () => {
    const temporary = `${markerFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...sent].sort()));
    fs.renameSync(temporary, markerFile);
  };
  return {
    has: (queueId) => sent.has(queueId),
    mark: (queueId) => {
      sent.add(queueId);
      persist();
    },
    clear: (queueId) => {
      sent.delete(queueId);
      persist();
    },
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid relay argument near ${key ?? '<end>'}`);
    }
    values[key.slice(2)] = value;
  }
  return values;
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('The live iMessage relay requires macOS');
  }
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args['base-url']?.replace(/\/$/, '');
  const expectedUserId = args['expected-user-id'];
  const expectedPhone = args['expected-phone'];
  const expectedMessage = args['expected-message'];
  const markerFile = args['marker-file'];
  const timeoutMs = Number(args['timeout-seconds']) * 1000;
  if (
    !baseUrl ||
    !expectedUserId ||
    !expectedPhone ||
    !expectedMessage ||
    !markerFile ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error(
      'Required: --base-url --expected-user-id --expected-phone --expected-message --marker-file --timeout-seconds'
    );
  }

  // Optional auto-login: when the launcher supplies benchmark credentials, the
  // relay signs the installed Rose app in (for the expected user) if it has no
  // usable session, instead of failing the run.
  const autoLoginPhone = args['auto-login-phone'];
  const autoLoginOtp = args['auto-login-otp'];
  const autoLogin =
    autoLoginPhone && autoLoginOtp ? { phone: autoLoginPhone, otp: autoLoginOtp } : undefined;

  const session = await loadInstalledRoseSession(expectedUserId, autoLogin, baseUrl);
  const authorization = `Bearer ${session.access_token}`;
  const fetchOutcome = async <T>(url: string, init?: RequestInit): Promise<RelayOutcome<T>> => {
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        return { ok: false, status: response.status, statusText: response.statusText };
      }
      const data = (await response.json()) as T;
      return { ok: true, status: response.status, statusText: response.statusText, data };
    } catch (error) {
      return { ok: false, status: 0, statusText: errorMessage(error) };
    }
  };

  const receipt = await runRelay(
    { expectedPhone, expectedMessage, timeoutMs, pollIntervalMs: 1_000 },
    {
      pop: () =>
        fetchOutcome<PopResponse>(`${baseUrl}/api/imessage/queue/pop`, {
          headers: {
            Authorization: authorization,
            'X-iMessage-Delivery-Results': 'v1',
          },
        }),
      report: (queueId, result) =>
        fetchOutcome(`${baseUrl}/api/imessage/queue/${encodeURIComponent(queueId)}/result`, {
          method: 'POST',
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(result),
        }),
      send: (to, message) => IMessageSender.send({ to, message }),
      markers: createFileMarkerStore(markerFile),
      now: () => Date.now(),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      log: (message) => console.log(`[cloudbench-imessage-relay] ${message}`),
    }
  );
  console.log(
    `[cloudbench-imessage-relay] complete queue_id=${receipt.queueId} agent_id=${receipt.agentId}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[cloudbench-imessage-relay] FATAL: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
