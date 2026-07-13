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

interface StoredSession {
  access_token?: string;
  expires_at?: number;
  user?: { id?: string };
}

function envValue(contents: string, key: string): string | undefined {
  const line = contents.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}=`));
  return line
    ?.slice(key.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

async function loadInstalledRoseSession(expectedUserId: string): Promise<StoredSession> {
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
  const store = new Store({
    name: 'navi-auth',
    cwd:
      process.env.ROSE_USER_DATA_DIR ||
      path.join(os.homedir(), 'Library', 'Application Support', 'Rose'),
    encryptionKey,
    clearInvalidConfig: false,
  });
  const session = store.get('session') as StoredSession | undefined;
  const expiresAt = session?.expires_at
    ? session.expires_at < 1_000_000_000_000
      ? session.expires_at * 1000
      : session.expires_at
    : 0;
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

  const session = await loadInstalledRoseSession(expectedUserId);
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
