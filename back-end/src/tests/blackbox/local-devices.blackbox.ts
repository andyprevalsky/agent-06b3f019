#!/usr/bin/env tsx
/**
 * Black-box contract for local (Mac) code agents (rose-builds-rose.md C14).
 *
 * State machine under test:
 *
 *   Mac app register (own JWT) ──────────────► device bound to that user forever
 *   another user / impersonated register ────► 403
 *   POST /api/agents from the Mac app ───────► Agent.originDeviceId = that Mac
 *   web/PWA create, or a device you don't own ► no origin (cloud only)
 *   worker asks agent-target:
 *     web-started tree ──────────────────────► not_mac_origin + exact text
 *     Mac closed (no control socket) ────────► device_disconnected + exact text, immediately
 *     Mac connected ─────────────────────────► available
 *   session create target=local, Mac closed ─► 409 exact text (no cloud fallback)
 *   relay: control/tunnel need the owner's JWT + device; clients need the
 *          per-task token; every client gets its own channel; a dropped Mac
 *          tunnel closes its clients; a missing Mac fails start at once.
 *
 * Section A drives the real hub over real sockets in-process (no DB, no
 * credentials). Section B drives the running backend's routes and sockets.
 */ import { config } from 'dotenv';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { originDeviceFields } from '../../domains/agents/agentOriginService';
import type { CreateAgentBody } from '../../domains/agents/types';
import { prisma } from '../../providers/database';
import { localTargetDisconnectedMessage } from '../../providers/localDevices/messages';
import {
  type OpenedSocket,
  type TestResult,
  deviceHeaders,
  expectRefused,
  openSocket,
  runTest,
  sectionA,
} from './local-devices.relay.cases';

config();

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3001';
const WS_BASE = BASE_URL.replace(/^http/, 'ws');
const API_KEY = process.env.BACKEND_API_KEY ?? '';
const DEVICE_NAME = "Blackbox's MacBook Pro";

// ── Section B: the running backend ──────────────────────────────────────

function userToken(userId: string, extra: Record<string, unknown> = {}): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  assert(secret && supabaseUrl, 'SUPABASE_JWT_SECRET and SUPABASE_URL are required');
  return jwt.sign({ sub: userId, ...extra }, secret, {
    algorithm: 'HS256',
    issuer: `${supabaseUrl}/auth/v1`,
    expiresIn: '10m',
  });
}

async function http(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data };
}

async function seedAgent(
  userId: string,
  source: 'WEB' | 'MAC_APP',
  origin: string | null,
  busId?: string
) {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId,
      goal: 'local devices blackbox',
      source,
      originDeviceId: origin,
      busId: busId ?? id,
      parentAgentId: busId ?? null,
    },
  });
  return id;
}

async function sectionB(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const userA = randomUUID();
  const userB = randomUUID();
  const deviceA = randomUUID();
  const deviceA2 = randomUUID();
  const foreignDevice = randomUUID();
  const createdAgents: string[] = [];
  await prisma.user.createMany({
    data: [
      { userId: userA, name: 'Local Devices A', usedInviteCode: 1 },
      { userId: userB, name: 'Local Devices B', usedInviteCode: 1 },
    ],
  });
  const tokenA = userToken(userA);
  const tokenB = userToken(userB);
  const internal = { 'X-API-Key': API_KEY };
  let control: OpenedSocket | null = null;
  try {
    results.push(
      await runTest('B1 register binds the Mac to its first owner', async () => {
        const body = { device_id: deviceA, name: DEVICE_NAME, app_version: '1.1.42' };
        const ok = await http('/api/local-devices/register', {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenA}` },
          body,
        });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
        assert.strictEqual((ok.data.device as { name: string }).name, DEVICE_NAME);
        const stolen = await http('/api/local-devices/register', {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenB}` },
          body,
        });
        assert.strictEqual(stolen.status, 403, JSON.stringify(stolen.data));
        const impersonated = await http('/api/local-devices/register', {
          method: 'POST',
          headers: { Authorization: `Bearer ${userToken(userA, { act: { sub: userB } })}` },
          body,
        });
        assert.strictEqual(impersonated.status, 403, JSON.stringify(impersonated.data));
        const bad = await http('/api/local-devices/register', {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokenA}` },
          body: { device_id: 'not-a-uuid', name: '' },
        });
        assert.strictEqual(bad.status, 400);
        const row = await prisma.localDevice.findUnique({
          where: { id: deviceA },
        });
        assert.strictEqual(row?.userId, userA);
      })
    );

    results.push(
      await runTest(
        'B2 agent create records the Mac only for Mac-app roots the user owns',
        async () => {
          const create = async (token: string, source: string, header?: string) => {
            const res = await http('/api/agents', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                ...(header !== undefined ? { 'X-Rose-Device-Id': header } : {}),
              },
              body: { goal: `local devices origin ${randomUUID().slice(0, 8)}`, source },
            });
            assert.strictEqual(res.status, 201, JSON.stringify(res.data));
            const agentId = res.data.agent_id as string;
            createdAgents.push(agentId);
            return prisma.agent.findUniqueOrThrow({
              where: { id: agentId },
              select: { source: true, originDeviceId: true },
            });
          };
          // Two real creates (each starts chat mode); the remaining origin rules
          // run through the same decision function the create route calls.
          assert.deepStrictEqual(await create(tokenA, 'MAC_APP', deviceA), {
            source: 'MAC_APP',
            originDeviceId: deviceA,
          });
          assert.deepStrictEqual(await create(tokenB, 'MAC_APP', deviceA), {
            source: 'MAC_APP',
            originDeviceId: null,
          });
          const body = (source: 'WEB' | 'MAC_APP') => ({ source }) as CreateAgentBody;
          assert.deepStrictEqual(await originDeviceFields(body('WEB'), userA, false, deviceA), {});
          assert.deepStrictEqual(
            await originDeviceFields(body('MAC_APP'), userA, true, deviceA),
            {}
          );
          assert.deepStrictEqual(
            await originDeviceFields(body('MAC_APP'), userA, false, undefined),
            {}
          );
          assert.deepStrictEqual(await originDeviceFields(body('MAC_APP'), userA, false, 'x'), {});
          assert.deepStrictEqual(await originDeviceFields(body('MAC_APP'), userA, false, deviceA), {
            originDeviceId: deviceA,
          });
        }
      )
    );

    const macRoot = await seedAgent(userA, 'MAC_APP', deviceA);
    const macChild = await seedAgent(userA, 'WEB', null, macRoot);
    const webRoot = await seedAgent(userA, 'WEB', null);
    const noDeviceRoot = await seedAgent(userB, 'WEB', null);
    createdAgents.push(macChild, macRoot, webRoot, noDeviceRoot);

    results.push(
      await runTest(
        'B3 agent-target: cloud and Mac trees report an owned disconnected Mac',
        async () => {
          const forbidden = await http(`/api/local-devices/agent-target/${macRoot}`, {
            headers: { Authorization: `Bearer ${tokenA}` },
          });
          assert.strictEqual(forbidden.status, 403);
          const noDevice = await http(`/api/local-devices/agent-target/${noDeviceRoot}`, {
            headers: internal,
          });
          assert.strictEqual(noDevice.data.reason, 'no_owned_device');
          assert.strictEqual(noDevice.data.device_id, null);
          assert.strictEqual(noDevice.data.device_name, null);
          const web = await http(`/api/local-devices/agent-target/${webRoot}`, {
            headers: internal,
          });
          assert.strictEqual(web.status, 200);
          assert.strictEqual(web.data.available, false);
          assert.strictEqual(web.data.reason, 'device_disconnected');
          assert.strictEqual(web.data.message, localTargetDisconnectedMessage(DEVICE_NAME));
          const began = Date.now();
          const closed = await http(`/api/local-devices/agent-target/${macChild}`, {
            headers: internal,
          });
          assert(Date.now() - began < 2000, `target lookup took ${Date.now() - began}ms`);
          assert.strictEqual(closed.data.available, false);
          assert.strictEqual(closed.data.reason, 'device_disconnected');
          assert.strictEqual(closed.data.device_name, DEVICE_NAME);
          assert.strictEqual(
            closed.data.message,
            "Can't run locally: the Rose Mac app on Blackbox's MacBook Pro is closed or disconnected. Open the Rose Mac app and retry, or run this agent in the cloud."
          );
          assert.strictEqual(closed.data.message, localTargetDisconnectedMessage(DEVICE_NAME));
        }
      )
    );

    results.push(
      await runTest(
        'B4 session create target=local fails with 409 + exact text, no cloud fallback',
        async () => {
          for (const [agentId, expected] of [
            [webRoot, localTargetDisconnectedMessage(DEVICE_NAME)],
            [macChild, localTargetDisconnectedMessage(DEVICE_NAME)],
          ] as const) {
            for (const path of [
              '/api/claude-code-session/create',
              '/api/codex-code-session/create',
            ]) {
              const before = await prisma.claudeCodeSession.count({ where: { agentId } });
              const res = await http(path, {
                method: 'POST',
                headers: internal,
                body: {
                  agent_id: agentId,
                  goal: 'fix it locally',
                  user_id: userA,
                  target: 'local',
                },
              });
              assert.strictEqual(res.status, 409, `${path} ${JSON.stringify(res.data)}`);
              assert.strictEqual(res.data.code, 'LOCAL_TARGET_UNAVAILABLE');
              assert.strictEqual(res.data.error, expected);
              assert.strictEqual(
                await prisma.claudeCodeSession.count({ where: { agentId } }),
                before
              );
            }
          }
        }
      )
    );

    results.push(
      await runTest(
        'B5 control socket: owner connects, others refused; target flips to available',
        async () => {
          await expectRefused(
            `${WS_BASE}/api/local-devices/control`,
            deviceHeaders(tokenB, deviceA),
            401
          );
          control = await openSocket(
            `${WS_BASE}/api/local-devices/control`,
            deviceHeaders(tokenA, deviceA)
          );
          const listA = await http('/api/local-devices', {
            headers: { Authorization: `Bearer ${tokenA}` },
          });
          const mine = (
            listA.data.devices as Array<{ device_id: string; connected: boolean }>
          ).find((d) => d.device_id === deviceA);
          assert.strictEqual(mine?.connected, true);
          const listB = await http('/api/local-devices', {
            headers: { Authorization: `Bearer ${tokenB}` },
          });
          assert.deepStrictEqual(listB.data.devices, []);
          const open = await http(`/api/local-devices/agent-target/${macChild}`, {
            headers: internal,
          });
          assert.deepStrictEqual(open.data, {
            available: true,
            device_id: deviceA,
            device_name: DEVICE_NAME,
          });
          const cloud = await http(`/api/local-devices/agent-target/${webRoot}`, {
            headers: internal,
          });
          assert.deepStrictEqual(cloud.data, open.data);
          await prisma.localDevice.createMany({
            data: [
              { id: deviceA2, userId: userA, name: 'Second Mac', platform: 'darwin' },
              {
                id: foreignDevice,
                userId: userB,
                name: 'Private foreign name',
                platform: 'darwin',
              },
            ],
          });
          const ambiguous = await http(`/api/local-devices/agent-target/${webRoot}`, {
            headers: internal,
          });
          assert.strictEqual(ambiguous.data.reason, 'device_selection_required');
          const stillPinned = await http(`/api/local-devices/agent-target/${macChild}`, {
            headers: internal,
          });
          assert.deepStrictEqual(stillPinned.data, open.data);
          for (const path of [
            '/api/claude-code-session/create',
            '/api/codex-code-session/create',
          ]) {
            const wrongOwner = await http(path, {
              method: 'POST',
              headers: internal,
              body: {
                agent_id: webRoot,
                user_id: userB,
                goal: 'local build',
                target: 'local',
                device_id: deviceA,
              },
            });
            assert.strictEqual(wrongOwner.status, 403, JSON.stringify(wrongOwner.data));
            assert.strictEqual(wrongOwner.data.code, 'AGENT_OWNER_MISMATCH');
            for (const deviceId of [deviceA2, foreignDevice, randomUUID()]) {
              const before = await prisma.claudeCodeSession.count({ where: { agentId: webRoot } });
              const rejected = await http(path, {
                method: 'POST',
                headers: internal,
                body: {
                  agent_id: webRoot,
                  user_id: userA,
                  goal: 'local build',
                  target: 'local',
                  device_id: deviceId,
                },
              });
              assert.strictEqual(rejected.status, 409, JSON.stringify(rejected.data));
              assert.strictEqual(
                rejected.data.reason,
                deviceId === deviceA2 ? 'device_disconnected' : 'no_owned_device'
              );
              assert.strictEqual(
                rejected.data.device_name,
                deviceId === deviceA2 ? 'Second Mac' : null
              );
              assert.strictEqual(
                await prisma.claudeCodeSession.count({ where: { agentId: webRoot } }),
                before
              );
            }
          }
          // Relay endpoints for another user's task are refused.
          await expectRefused(
            `${WS_BASE}/api/local-code-relay/${randomUUID()}/device`,
            deviceHeaders(tokenB, deviceA),
            401
          );
          await expectRefused(`${WS_BASE}/api/local-code-relay/${randomUUID()}?token=x`, {}, 401);
          control.ws.close();
          await control.closed;
          control = null;
          await new Promise((done) => setTimeout(done, 100));
          const closedAgain = await http(`/api/local-devices/agent-target/${macRoot}`, {
            headers: internal,
          });
          assert.strictEqual(closedAgain.data.reason, 'device_disconnected');
        }
      )
    );
  } finally {
    (control as OpenedSocket | null)?.ws.close();
    for (const id of createdAgents) {
      await prisma.message.deleteMany({ where: { agentId: id } }).catch(() => undefined);
      await prisma.claudeCodeSession.deleteMany({ where: { agentId: id } }).catch(() => undefined);
      await prisma.agent.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await prisma.localDevice.deleteMany({
      where: { id: { in: [deviceA, deviceA2, foreignDevice] } },
    });
    await prisma.user.deleteMany({ where: { userId: { in: [userA, userB] } } });
  }
  return results;
}

async function runTests(): Promise<boolean> {
  const results = [...(await sectionA()), ...(await sectionB())];
  let allPassed = true;
  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    console.log(
      `${icon} ${result.name} (${result.duration}ms)${result.error ? `\n   ${result.error}` : ''}`
    );
    if (!result.passed) allPassed = false;
  }
  return allPassed;
}

runTests()
  .then(async (ok) => {
    await prisma.$disconnect();
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
