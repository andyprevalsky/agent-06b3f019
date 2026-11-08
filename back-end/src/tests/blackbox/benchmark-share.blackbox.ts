#!/usr/bin/env tsx

/** A bearer link reads only its archived run, without an auth session. */
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

config();

const base = process.env.TEST_BASE_URL || 'http://localhost:3001';
const key = process.env.BACKEND_API_KEY;
if (!key) throw new Error('BACKEND_API_KEY is required for benchmark-share blackbox');
const shareSecret = process.env.BENCHMARK_SHARE_SECRET;
if (!shareSecret)
  throw new Error('BENCHMARK_SHARE_SECRET is required for benchmark-share blackbox');

function token(runId: string, expiry: number): string {
  const signature = createHmac('sha256', shareSecret)
    .update(`benchmark-share:v1:${runId}:${expiry}`)
    .digest('hex');
  return `${runId}.${expiry}.${signature}`;
}

async function expectStatus(url: string, status: number, shareToken?: string): Promise<Response> {
  const response = await fetch(url, {
    headers: shareToken ? { Authorization: `BenchmarkShare ${shareToken}` } : {},
  });
  if (response.status !== status) {
    throw new Error(`${url.split('?')[0]}: expected ${status}, got ${response.status}`);
  }
  return response;
}

/**
 * The local Hub's index lock is a per-database Postgres advisory lock, so a
 * sibling coverage shard on another database sharing one Hub directory could
 * overwrite this run out of the index (cleanup then 404s). Uploads must land in
 * the runner's own artifact-scoped Hub directory, never the shared worktree one.
 */
function assertRunScopedHubStorage(runId: string): void {
  const hubDir = process.env.BENCHMARK_HUB_LOCAL_DIR;
  const artifactDir = process.env.BLACKBOX_TEST_ARTIFACT_DIR;
  if (!hubDir || !artifactDir) {
    throw new Error('runner must export BENCHMARK_HUB_LOCAL_DIR and BLACKBOX_TEST_ARTIFACT_DIR');
  }
  const relative = path.relative(path.resolve(artifactDir), path.resolve(hubDir));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Hub directory ${hubDir} is not scoped to the run artifacts ${artifactDir}`);
  }
  if (!existsSync(path.join(hubDir, 'runs', `${runId}.json`))) {
    throw new Error('backend did not store the upload in the run-scoped Hub directory');
  }
  const shared = path.resolve(
    __dirname,
    '../../../../.context/benchmark-hub/runs',
    `${runId}.json`
  );
  if (existsSync(shared)) throw new Error('upload reached the shared worktree Hub directory');
}

async function main(): Promise<void> {
  const runId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const internalHeaders = { 'X-API-Key': key!, 'Content-Type': 'application/json' };
  const bundle = {
    run_id: runId,
    timestamp: new Date().toISOString(),
    suite: 'benchmark-share-blackbox',
    tasks: [
      {
        name: 'shared-agent-contract',
        agent_id: agentId,
        passed: true,
        logs: {
          tree: {},
          messages: [
            { role: 'USER', message: 'Show this benchmark' },
            { role: 'ASSISTANT', message: 'VISIBLE_TRANSCRIPT_CANARY' },
          ],
        },
      },
    ],
  };
  const upload = await fetch(`${base}/api/benchmarks/runs`, {
    method: 'POST',
    headers: internalHeaders,
    body: JSON.stringify(bundle),
  });
  if (upload.status !== 201) throw new Error(`fixture upload failed: ${upload.status}`);
  let cleanupStatus = 0;
  try {
    assertRunScopedHubStorage(runId);
    const now = Math.floor(Date.now() / 1000);
    const url = `${base}/api/benchmarks/shared-agent/${agentId}`;
    await expectStatus(url, 403);
    await expectStatus(`${url}?share=${token(runId, now + 3600)}`, 403);
    await expectStatus(url, 403, token(runId, now - 1));
    await expectStatus(url, 403, token(runId, now + 32 * 86400));
    await expectStatus(url, 404, token(otherAgentId, now + 3600));
    const valid = token(runId, now + 3600);
    const tampered = `${valid.slice(0, -1)}${valid.endsWith('0') ? '1' : '0'}`;
    await expectStatus(url, 403, tampered);
    const response = await expectStatus(url, 200, valid);
    const detail = (await response.json()) as {
      agent: { agent_id: string };
      messages: Array<{ text: string }>;
    };
    if (
      detail.agent.agent_id !== agentId ||
      !detail.messages.some((message) => message.text === 'VISIBLE_TRANSCRIPT_CANARY')
    ) {
      throw new Error('unauthenticated shared view did not return the recorded agent');
    }
    await expectStatus(`${base}/api/benchmarks/shared-agent/${otherAgentId}`, 404, valid);
    process.stdout.write('benchmark-share blackbox: scoped anonymous transcript visible\n');
  } finally {
    const cleanup = await fetch(`${base}/api/benchmarks/runs/${runId}`, {
      method: 'DELETE',
      headers: internalHeaders,
    });
    cleanupStatus = cleanup.status;
  }
  if (cleanupStatus !== 200) throw new Error(`fixture cleanup failed: ${cleanupStatus}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
