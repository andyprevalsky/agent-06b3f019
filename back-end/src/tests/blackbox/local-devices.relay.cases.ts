/**
 * Local devices blackbox, section A: the real relay hub over real sockets,
 * in-process (no DB, no credentials). Registered by local-devices.blackbox.ts.
 */
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import {
  LocalDeviceHub,
  LocalSessionStartError,
  localDeviceSandboxId,
  parseLocalDeviceSandboxId,
} from '../../providers/localDevices/hub';
import { relayDevicePath } from '../../providers/localDevices/protocol';
import { localHomeFromWorkspace } from '../../providers/localDevices/homeFiles';
import type { UserUiWorkspace } from '../../providers/userUi/workspace';

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

export async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

// ── socket helpers ───────────────────────────────────────────────────────

export interface OpenedSocket {
  ws: WebSocket;
  messages: string[];
  closed: Promise<{ code: number; reason: string }>;
  next: (predicate?: (message: string) => boolean, timeoutMs?: number) => Promise<string>;
}

export function openSocket(
  url: string,
  headers: Record<string, string> = {}
): Promise<OpenedSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const messages: string[] = [];
    const waiters: Array<{ predicate: (m: string) => boolean; resolve: (m: string) => void }> = [];
    ws.on('message', (raw) => {
      const text = raw.toString();
      messages.push(text);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(text)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(text);
        }
      }
    });
    const closed = new Promise<{ code: number; reason: string }>((done) => {
      ws.on('close', (code, reason) => done({ code, reason: reason.toString() }));
    });
    const next = (predicate: (m: string) => boolean = () => true, timeoutMs = 5000) =>
      new Promise<string>((done, fail) => {
        const seen = messages.find(predicate);
        if (seen !== undefined) {
          messages.splice(messages.indexOf(seen), 1);
          done(seen);
          return;
        }
        const timer = setTimeout(() => fail(new Error('timed out waiting for a frame')), timeoutMs);
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer);
            messages.splice(messages.indexOf(m), 1);
            done(m);
          },
        });
      });
    ws.once('open', () => resolve({ ws, messages, closed, next }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

export async function expectRefused(url: string, headers: Record<string, string>, status: number) {
  try {
    const opened = await openSocket(url, headers);
    opened.ws.close();
  } catch (error) {
    assert.strictEqual((error as Error).message, `HTTP ${status}`);
    return;
  }
  throw new Error(`expected HTTP ${status}, the socket opened`);
}

export function frame(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

// ── Section A: the hub in-process ───────────────────────────────────────

interface Harness {
  hub: LocalDeviceHub;
  server: Server;
  base: string;
  deviceA: string;
  deviceB: string;
}

async function startHarness(): Promise<Harness> {
  const deviceA: string = randomUUID();
  const deviceB: string = randomUUID();
  const devices = new Map([
    [
      deviceA,
      {
        id: deviceA,
        userId: 'user-a',
        name: 'Mac A',
        platform: 'darwin',
        appVersion: null,
        lastSeenAt: new Date(),
      },
    ],
    [
      deviceB,
      {
        id: deviceB,
        userId: 'user-b',
        name: 'Mac B',
        platform: 'darwin',
        appVersion: null,
        lastSeenAt: new Date(),
      },
    ],
  ]);
  const hub = new LocalDeviceHub({
    verifyUser: async (token) => ({ 'tok-a': 'user-a', 'tok-b': 'user-b' })[token] ?? null,
    findDevice: async (id) => devices.get(id) ?? null,
    findActiveSession: async () => null,
    touchDevice: async () => undefined,
    relaySecret: () => 'blackbox-relay-secret',
    pingIntervalMs: 60_000,
  });
  const server = createServer();
  hub.attach(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { hub, server, base: `ws://127.0.0.1:${port}`, deviceA, deviceB };
}

async function stopHarness(h: Harness): Promise<void> {
  h.hub.close();
  await new Promise<void>((done) => h.server.close(() => done()));
}

export const deviceHeaders = (token: string, deviceId: string) => ({
  Authorization: `Bearer ${token}`,
  'x-rose-device-id': deviceId,
});

/** Start a session as the Mac would: answer session_started and open the tunnel. */
async function startAsMac(h: Harness, control: OpenedSocket, taskId: string) {
  const started = h.hub.startSession({
    deviceId: h.deviceA,
    userId: 'user-a',
    command: {
      type: 'start_session',
      task_id: taskId,
      agent_id: randomUUID(),
      provider: 'claude',
      folder: null,
      envs: { CLAUDE_CODE_GOAL: 'g' },
      relay_path: relayDevicePath(taskId),
      home_files: [],
    },
  });
  const command = frame(await control.next((m) => frame(m).type === 'start_session'));
  assert.strictEqual(command.task_id, taskId);
  assert.strictEqual(command.relay_path, `/api/local-code-relay/${taskId}/device`);
  const tunnel = await openSocket(
    `${h.base}${relayDevicePath(taskId)}`,
    deviceHeaders('tok-a', h.deviceA)
  );
  control.ws.send(
    JSON.stringify({ type: 'session_started', task_id: taskId, folder: '/Users/a/code' })
  );
  assert.deepStrictEqual(await started, { folder: '/Users/a/code' });
  return tunnel;
}

export async function sectionA(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const h = await startHarness();
  try {
    results.push(
      await runTest('A1 control channel requires the device owner JWT', async () => {
        await expectRefused(
          `${h.base}/api/local-devices/control`,
          deviceHeaders('tok-b', h.deviceA),
          401
        );
        await expectRefused(
          `${h.base}/api/local-devices/control`,
          { 'x-rose-device-id': h.deviceA },
          401
        );
        await expectRefused(
          `${h.base}/api/local-devices/control`,
          deviceHeaders('tok-a', randomUUID()),
          401
        );
        const control = await openSocket(
          `${h.base}/api/local-devices/control`,
          deviceHeaders('tok-a', h.deviceA)
        );
        assert.strictEqual(h.hub.isDeviceConnected(h.deviceA), true);
        control.ws.close();
        await control.closed;
        await new Promise((done) => setTimeout(done, 50));
        assert.strictEqual(h.hub.isDeviceConnected(h.deviceA), false);
      })
    );

    results.push(
      await runTest('A2 start on a closed Mac fails at once (no waiting)', async () => {
        const began = Date.now();
        await assert.rejects(
          h.hub.startSession({
            deviceId: h.deviceA,
            userId: 'user-a',
            command: {
              type: 'start_session',
              task_id: randomUUID(),
              agent_id: randomUUID(),
              provider: 'claude',
              folder: null,
              envs: {},
              relay_path: '/x',
              home_files: [],
            },
          }),
          (error: unknown) =>
            error instanceof LocalSessionStartError && error.code === 'device_disconnected'
        );
        assert(Date.now() - began < 200, `took ${Date.now() - began}ms`);
      })
    );

    results.push(
      await runTest('A3 relay is per task, owner-scoped, one channel per client', async () => {
        const control = await openSocket(
          `${h.base}/api/local-devices/control`,
          deviceHeaders('tok-a', h.deviceA)
        );
        const taskId = randomUUID();
        const otherTask = randomUUID();
        const tunnel = await startAsMac(h, control, taskId);
        // Another user's Mac cannot serve (or hijack) this task's tunnel.
        await expectRefused(
          `${h.base}${relayDevicePath(taskId)}`,
          deviceHeaders('tok-b', h.deviceB),
          403
        );
        // Clients need this task's token; another task's token is refused.
        await expectRefused(`${h.base}/api/local-code-relay/${taskId}?token=nope`, {}, 401);
        await expectRefused(
          `${h.base}/api/local-code-relay/${taskId}?token=${h.hub.relayToken(otherTask)}`,
          {},
          401
        );
        const url = h.hub.relayClientUrl(taskId, h.base.replace('ws://', 'http://'));
        assert(url.startsWith(`${h.base}/api/local-code-relay/${taskId}?token=`), url);
        const worker = await openSocket(url);
        const open1 = frame(await tunnel.next((m) => frame(m).op === 'open'));
        const viewer = await openSocket(url);
        const open2 = frame(await tunnel.next((m) => frame(m).op === 'open'));
        assert.notStrictEqual(open1.ch, open2.ch);
        // Mac → one client only.
        tunnel.ws.send(
          JSON.stringify({ op: 'data', ch: open1.ch, data: '{"type":"stdout","data":"hi"}' })
        );
        assert.strictEqual(await worker.next(), '{"type":"stdout","data":"hi"}');
        await new Promise((done) => setTimeout(done, 50));
        assert.deepStrictEqual(viewer.messages, []);
        // Client → Mac carries its channel.
        worker.ws.send('{"type":"stdin","data":"x"}');
        const up = frame(await tunnel.next((m) => frame(m).op === 'data'));
        assert.deepStrictEqual(up, {
          op: 'data',
          ch: open1.ch,
          data: '{"type":"stdin","data":"x"}',
        });
        viewer.ws.close();
        const closeFrame = frame(await tunnel.next((m) => frame(m).op === 'close'));
        assert.strictEqual(closeFrame.ch, open2.ch);
        assert.strictEqual(h.hub.isSessionTunnelConnected(taskId), true);
        // A dropped Mac tunnel closes its clients; new clients are refused until it returns.
        tunnel.ws.close();
        assert.strictEqual((await worker.closed).code, 1012);
        const late = await openSocket(url);
        assert.strictEqual((await late.closed).code, 1013);
        await h.hub.stopSession(taskId, h.deviceA);
        const stop = frame(await control.next((m) => frame(m).type === 'stop_session'));
        assert.strictEqual(stop.task_id, taskId);
        control.ws.close();
        await control.closed;
      })
    );

    results.push(
      await runTest('A4 no shared folder on the Mac fails the start with its code', async () => {
        const control = await openSocket(
          `${h.base}/api/local-devices/control`,
          deviceHeaders('tok-a', h.deviceA)
        );
        const taskId = randomUUID();
        const started = h.hub.startSession({
          deviceId: h.deviceA,
          userId: 'user-a',
          command: {
            type: 'start_session',
            task_id: taskId,
            agent_id: randomUUID(),
            provider: 'claude',
            folder: null,
            envs: {},
            relay_path: relayDevicePath(taskId),
            home_files: [],
          },
        });
        await control.next((m) => frame(m).type === 'start_session');
        control.ws.send(
          JSON.stringify({
            type: 'session_failed',
            task_id: taskId,
            code: 'no_folder_granted',
            error: 'none',
          })
        );
        await assert.rejects(
          started,
          (error: unknown) =>
            error instanceof LocalSessionStartError && error.code === 'no_folder_granted'
        );
        control.ws.close();
        await control.closed;
      })
    );

    results.push(
      await runTest('A5 sandbox id names its Mac and task', async () => {
        const taskId = randomUUID();
        const sandboxId = localDeviceSandboxId(h.deviceA, taskId);
        assert.deepStrictEqual(parseLocalDeviceSandboxId(sandboxId), {
          deviceId: h.deviceA,
          taskId,
        });
        assert.strictEqual(parseLocalDeviceSandboxId(`local-${taskId}`), null);
      })
    );

    results.push(
      await runTest('A6 hello tells the hub where the Mac keeps session HOMEs', async () => {
        const control = await openSocket(
          `${h.base}/api/local-devices/control`,
          deviceHeaders('tok-a', h.deviceA)
        );
        assert.strictEqual(h.hub.deviceSessionHome(h.deviceA, 't-1'), null);
        control.ws.send(
          JSON.stringify({ type: 'hello', sessions: [], sessions_root: '/Users/a/Rose/sessions/' })
        );
        await new Promise((done) => setTimeout(done, 50));
        assert.strictEqual(h.hub.deviceSessionHome(h.deviceA, 't-1'), '/Users/a/Rose/sessions/t-1');
        control.ws.close();
        await control.closed;
      })
    );

    results.push(
      await runTest('A7 local HOME carries the sandbox tools, relocated to the Mac', async () => {
        const home = '/Users/a/Library/Application Support/Rose/local-code-sessions/t-1';
        const workspace: UserUiWorkspace = {
          files: [
            { path: '.rose/bin/rose', content: Buffer.from('#!/usr/bin/env node\n') },
            { path: '.rose/bin/rose-agents', content: Buffer.from('#!/usr/bin/env node\n') },
            { path: '.rose/tools.json', content: Buffer.from('{}') },
            { path: '.rose/mcp.json', content: Buffer.from('{}') },
            { path: '.rose/skills/talk-to-user/SKILL.md', content: Buffer.from('skill') },
            { path: '.claude/skills/talk-to-user/SKILL.md', content: Buffer.from('skill') },
          ],
          envs: {
            ROSE_TOOLS_URL: 'https://api.example.com/api/agent-tools/agent-1',
            ROSE_TOOLS_TOKEN: 'tools-token',
            ROSE_AGENTS_URL: 'https://api.example.com/api/agents/graph',
            ROSE_AGENTS_TOKEN: 'graph-token',
          },
          source: { kind: 'seed' },
        } as UserUiWorkspace;
        const local = localHomeFromWorkspace(workspace, home);
        const byPath = new Map(local.files.map((file) => [file.path, file]));
        assert.strictEqual(byPath.get('.rose/bin/rose')?.executable, true);
        assert.strictEqual(byPath.get('.rose/bin/rose-agents')?.executable, true);
        // Rose skills (C17) ship as plain files in every HOME root.
        assert.strictEqual(byPath.get('.rose/skills/talk-to-user/SKILL.md')?.executable, false);
        assert.strictEqual(byPath.get('.claude/skills/talk-to-user/SKILL.md')?.executable, false);
        const mcp = JSON.parse(
          Buffer.from(byPath.get('.rose/mcp.json')?.content_base64 ?? '', 'base64').toString()
        ) as { mcpServers: { rose: { args: string[] } } };
        assert.deepStrictEqual(mcp.mcpServers.rose.args, [`${home}/.rose/bin/rose`, 'mcp']);
        const tools = JSON.parse(
          Buffer.from(byPath.get('.rose/tools.json')?.content_base64 ?? '', 'base64').toString()
        ) as Record<string, string>;
        assert.strictEqual(tools.url, 'https://api.example.com/api/agent-tools/agent-1');
        assert.strictEqual(tools.token, 'tools-token');
        assert.strictEqual(local.envs.ROSE_TOOLS_TOKEN, 'tools-token');
        assert.strictEqual(local.envs.ROSE_AGENTS_URL, 'https://api.example.com/api/agents/graph');
        assert.deepStrictEqual(localHomeFromWorkspace(null, home), { files: [], envs: {} });
      })
    );
  } finally {
    await stopHarness(h);
  }
  return results;
}
