/**
 * Process harness for multi-instance.blackbox.ts: spawns simulated backend
 * instances (multi-instance.instance.ts) and waits on their output and sockets.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import WebSocket from 'ws';
import { retryWithBackoff } from '../../providers/retry';

const INSTANCE_SCRIPT = join(__dirname, 'multi-instance.instance.ts');

export interface Instance {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  ready: Promise<void>;
  result: Promise<Record<string, unknown>>;
}

export function startInstance(
  op: string,
  args: string[],
  env: Record<string, string> = {}
): Instance {
  const child = spawn(process.execPath, ['--import', 'tsx', INSTANCE_SCRIPT, op, ...args], {
    cwd: join(__dirname, '..', '..', '..'),
    env: { ...process.env, ...env },
  });
  let out = '';
  let err = '';
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    if (out.includes('READY\n')) markReady();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (line === undefined) {
        reject(new Error(`instance ${op} exited ${code} without a result: ${err.slice(-400)}`));
        return;
      }
      resolve(JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>);
    });
  });
  return { child, output: () => out, ready, result };
}

export async function waitForAsync(
  cond: () => Promise<boolean>,
  what: string,
  timeoutMs = 20_000
): Promise<void> {
  const polls = Math.ceil(timeoutMs / 100);
  const met = await retryWithBackoff(cond, {
    maxRetries: polls,
    fixedDelays: Array<number>(polls).fill(100),
    shouldRetryResult: (ok) => !ok,
    component: 'MultiInstanceWait',
  });
  if (!met) throw new Error(`timed out waiting for ${what}`);
}

export async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, async () => {
      const server = createNetServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      return server;
    })
  );
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

export async function waitFor(
  cond: () => boolean,
  what: string,
  timeoutMs = 20_000
): Promise<void> {
  const polls = Math.ceil(timeoutMs / 50);
  const met = await retryWithBackoff(async () => cond(), {
    maxRetries: polls,
    fixedDelays: Array<number>(polls).fill(50),
    shouldRetryResult: (ok) => !ok,
    component: 'MultiInstanceWait',
  });
  if (!met) throw new Error(`timed out waiting for ${what}`);
}

/** A WebSocket that records text frames, with a promise for the next matching one. */
export async function frames(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const seen: string[] = [];
  ws.on('message', (raw) => seen.push(raw.toString()));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const next = async (
    match: (frame: Record<string, unknown> | string) => boolean,
    what: string
  ) => {
    let found: string | undefined;
    await waitFor(() => {
      found = seen.find((text) => {
        let parsed: Record<string, unknown> | string = text;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // plain text frame
        }
        return match(parsed);
      });
      return found !== undefined;
    }, what);
    seen.splice(seen.indexOf(found as string), 1);
    try {
      return JSON.parse(found as string) as Record<string, unknown>;
    } catch {
      return { text: found };
    }
  };
  return { ws, next };
}

/** Run one operation per instance with their critical sections released together. */
export async function concurrently(
  ops: Array<[string, string[]]>,
  env: Record<string, string> = {}
): Promise<Array<Record<string, unknown>>> {
  const instances = ops.map(([op, args]) => startInstance(op, args, env));
  await Promise.all(instances.map((i) => i.ready));
  for (const i of instances) i.child.stdin.write('GO\n');
  return Promise.all(instances.map((i) => i.result));
}
