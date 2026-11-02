#!/usr/bin/env tsx
/**
 * Black-box tests for DEMO cache cross-user isolation (live server + local DB).
 *
 * The shared DEMO store is keyed by goal text and trace hash, never by owner,
 * so any reader of a DEMO prompt replays what any writer stored there. These
 * cases pin that only recorder accounts write it, while any user still replays:
 *  - agent-flag writeEnabled is false for a non-recorder DEMO run
 *  - code-agent proxies record only with a server-signed recorder capability;
 *    forged, unsigned or absent capabilities never store a live miss
 *
 * Usage: npx tsx src/tests/blackbox/demo-cache-isolation.blackbox.ts
 */

import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { anthropicSlotKey } from '../../providers/anthropicProxyCore';
import {
  buildFastModeAnthropicEnv,
  signProxyTraceSegment,
} from '../../providers/codeAgentFastModeEnv';
import {
  demoCacheWriteCapability,
  resolveFastModeWriteEnabled,
} from '../../providers/demoCacheAccountPolicy';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const USER_ID = process.env.TEST_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const headers = {
  'X-API-Key': API_KEY,
  'X-User-Id': USER_ID,
  'Content-Type': 'application/json',
};

type JsonObject = Record<string, unknown>;

async function post(path: string, body: unknown): Promise<{ status: number; json: JsonObject }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as JsonObject;
  return { status: res.status, json };
}

async function main(): Promise<void> {
  const goalHash = `bbiso${Date.now().toString(16)}`;

  await test('only recorder accounts write the shared DEMO namespace', async () => {
    // The DEMO namespace is keyed by goal text alone, so every reader of a DEMO
    // prompt replays whatever any writer stored there. A non-recorder user may
    // replay the recording but must never add their own live outputs to it.
    const databaseUrl = process.env.DATABASE_URL;
    assert(databaseUrl, 'DATABASE_URL must point at the runner database');
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const demoGoal =
      'DEMO fleet concurrency probe alpha: call attempt_completion with result READY and stop. Do not use other tools.';
    const otherUserId = randomUUID();
    const agentIds = { recorder: randomUUID(), other: randomUUID(), otherPrivate: randomUUID() };
    try {
      await prisma.user.create({ data: { userId: otherUserId, name: 'DEMO isolation user' } });
      const rows = [
        { id: agentIds.recorder, userId: USER_ID, goal: demoGoal },
        { id: agentIds.other, userId: otherUserId, goal: demoGoal },
        { id: agentIds.otherPrivate, userId: otherUserId, goal: `private goal ${Date.now()}` },
      ];
      for (const row of rows) {
        await prisma.agent.create({
          data: { ...row, status: 'COMPLETED', title: 'demo isolation', model: 'rose-1-ultra' },
        });
      }
      const flag = async (agentId: string) =>
        (await post('/api/fast-cache/agent-flag', { agentId })).json;

      const recorder = await flag(agentIds.recorder);
      assert(recorder.enabled === true, 'recorder DEMO run must replay');
      assert(recorder.writeEnabled === true, 'recorder DEMO run must still record');

      const other = await flag(agentIds.other);
      assert(other.enabled === true, 'any user running a DEMO prompt still replays the demo');
      assert(other.writeEnabled === false, "a non-recorder's live outputs must never be stored");
      assert(
        resolveFastModeWriteEnabled(other.enabled === true, otherUserId) === false,
        'code-agent proxy must not record a non-recorder DEMO session'
      );
      assert(
        resolveFastModeWriteEnabled(true, USER_ID) === true,
        'code-agent proxy still records a recorder DEMO session'
      );

      const otherPrivate = await flag(agentIds.otherPrivate);
      assert(otherPrivate.enabled === false, 'non-DEMO goals never read the shared store');
      assert(otherPrivate.writeEnabled === false, 'non-DEMO goals never write the shared store');
    } finally {
      await prisma.agent.deleteMany({ where: { id: { in: Object.values(agentIds) } } });
      await prisma.user.deleteMany({ where: { userId: otherUserId } });
      await prisma.$disconnect();
    }
  });

  await test('code-agent proxies record only with a server-signed recorder capability', async () => {
    // Non-recorder sessions get the plain (replay-only) trace URL; recorders a
    // signed `record.<sig>` segment bound to their exact trace.
    // Codex never uses the cache (S30); only the Claude Code proxy exists.
    const nonRecorderWrite = resolveFastModeWriteEnabled(true, randomUUID());
    const anthropicUrl = buildFastModeAnthropicEnv(
      'demo goal',
      true,
      'https://api.example.com/anthropic-proxy',
      nonRecorderWrite
    ).ANTHROPIC_BASE_URL;
    assert(
      /\/anthropic-proxy\/[0-9a-f]{16},[0-9a-f]{32}$/.test(anthropicUrl ?? ''),
      `anthropic ${anthropicUrl}`
    );
    const recorderUrl = buildFastModeAnthropicEnv(
      'demo goal',
      true,
      'https://api.example.com/anthropic-proxy',
      resolveFastModeWriteEnabled(true, USER_ID)
    ).ANTHROPIC_BASE_URL;
    assert(/\/record\.[0-9a-f]{32}$/.test(recorderUrl ?? ''), `anthropic recorder ${recorderUrl}`);

    // The real proxy routers against a 2xx fake upstream and the runner DB:
    // a forged or absent capability must never store a slot; a signed one does.
    // Like Cloudflare in front of chatgpt.com: a request still carrying another
    // edge's client headers (Render adds them to every inbound request) is 403.
    const upstream = http.createServer((req, res) => {
      const edge = Object.keys(req.headers).filter((h) =>
        /^(cf-|x-forwarded-|true-client-ip$)/.test(h)
      );
      if (edge.length > 0) {
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end(`edge headers forwarded upstream: ${edge.join(',')}`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"live":true}\n\n');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamPort = (upstream.address() as AddressInfo).port;
    process.env.FAST_MODE_ANTHROPIC_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
    const { anthropicProxyRouter } = await import('../../domains/demo-cache/routes.proxy');
    const app = express();
    app.use(express.json());
    app.use('/anthropic-proxy', anthropicProxyRouter);
    const proxy = app.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    const forged = '0'.repeat(32);
    const cases = [
      { name: 'plain', mode: '', stored: false },
      { name: 'forged', mode: `record.${forged}/`, stored: false },
      { name: 'forged-record-only', mode: `record-only.${forged}/`, stored: false },
      { name: 'unsigned-record-only', mode: 'record-only/', stored: false },
      { name: 'signed', mode: 'SIGNED', stored: true },
    ];
    try {
      for (const c of cases) {
        for (const kind of ['anthropic'] as const) {
          const trace = `${goalHash}${c.name.replace(/-/g, '')}${kind}`.slice(0, 40);
          const capability = demoCacheWriteCapability(trace);
          assert(capability !== null, 'SUPABASE_JWT_SECRET is required for the signed case');
          const mode = c.mode === 'SIGNED' ? `record.${capability}/` : c.mode;
          const url = `${base}/anthropic-proxy/${signProxyTraceSegment(trace)}/${mode}v1/messages`;
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              authorization: 'Bearer test',
              // What Render's edge adds before the request reaches the proxy.
              'cf-connecting-ip': '203.0.113.7',
              'cf-visitor': '{"scheme":"https"}',
              'cf-ray': '0000000000000000-SJC',
              'x-forwarded-for': '203.0.113.7',
              'x-forwarded-proto': 'https',
              'true-client-ip': '203.0.113.7',
            },
            body: JSON.stringify({ model: 'm', input: [], messages: [] }),
          });
          const text = await res.text();
          assert(
            res.status === 200,
            `${kind} ${c.name} status ${res.status}: ${text.slice(0, 120)}`
          );
          const key = anthropicSlotKey(trace, 0);
          const row = await prisma.fastModeCacheEntry.findUnique({ where: { key } });
          assert((row !== null) === c.stored, `${kind} ${c.name}: stored=${row !== null}`);
          await prisma.fastModeCacheEntry.deleteMany({ where: { key } });
        }
      }
    } finally {
      await prisma.$disconnect();
      proxy.close();
      upstream.close();
    }
  });

  const purge = await post('/api/fast-cache/purge', { goalHash });
  assert(purge.status === 200, `purge status ${purge.status}`);

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\n✅ demo-cache-isolation blackbox: ${passed}/${passed} passed`);
}

void main();
