/** Activity -> authenticated HTTP -> Prisma/checkpoint -> new Chromium -> activity. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retryWithBackoff } from '../../providers/retry';
import { runBrowserE2EProcessCases } from './browser-session-e2e-process.cases';
import {
  TestChildProcesses,
  runOwnedTestChild,
  withTestDeadline,
  type OwnedTestChild,
} from './browser-session-e2e-process.support';

async function runChild(command: string, args: string[], timeout: number) {
  return runOwnedTestChild(command, args, {
    cwd: resolve('..'),
    env: process.env,
    timeoutMs: timeout,
  });
}

export async function runBrowserApprovalE2ECases(): Promise<void> {
  await runBrowserE2EProcessCases();
  const directory = await mkdtemp(join(tmpdir(), 'browser-approval-e2e-'));
  const ready = join(directory, 'ready.json');
  const children = new TestChildProcesses();
  let server: OwnedTestChild | undefined;
  let output = '';
  let endpoint = '';
  try {
    server = children.spawn(
      process.execPath,
      ['--import', 'tsx', 'src/tests/blackbox/browser-session-approval-e2e.worker.ts', ready],
      {
        cwd: process.cwd(),
        env: process.env,
      }
    );
    server.child.stdout!.on('data', (data) => {
      output = (output + data.toString()).slice(-24_000);
    });
    server.child.stderr!.on('data', (data) => {
      output = (output + data.toString()).slice(-24_000);
    });
    const ownedServer = server;
    endpoint = await retryWithBackoff(
      async () => {
        assert.ok(!ownedServer.exited, `E2E server failed:\n${output}`);
        return (JSON.parse(await readFile(ready, 'utf8')) as { api_url: string }).api_url;
      },
      {
        maxRetries: 1200,
        initialBackoffMs: 100,
        fixedDelays: Array.from({ length: 1199 }, () => 100),
        isRetryable: (error) => (error as NodeJS.ErrnoException).code === 'ENOENT',
        component: 'BrowserPauseE2EReady',
      }
    );
    assert.ok(endpoint, `E2E server readiness failed:\n${output}`);
    const descriptor = JSON.parse(await readFile(ready, 'utf8')) as Record<string, unknown>;
    const modes = process.env.BROWSER_E2E_HANDLER_SOURCE
      ? ['normal']
      : ['normal', 'capture_failure', 'auth'];
    for (const mode of modes) {
      const response = await fetch(`${endpoint}/__test/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      assert.equal(response.status, 200, await response.text());
      await writeFile(ready, JSON.stringify({ ...descriptor, mode }));
      const result = await runChild(
        resolve('../agents/venv/bin/python'),
        ['agents/tests/blackbox/browser_pause_e2e_support.py', '--manifest', ready],
        180_000
      );
      console.log(`PASS browser approval real E2E ${mode}: ${result.trim()}`);
    }
  } finally {
    try {
      if (endpoint) {
        await fetch(`${endpoint}/__test/shutdown`, {
          method: 'POST',
          signal: AbortSignal.timeout(2000),
        }).catch(() => {});
        if (server) {
          const result = await withTestDeadline(server.wait(10_000), 11_000, 'E2E server shutdown');
          assert.ok(result, `E2E worker did not complete shutdown: ${output}`);
          assert.equal(result.error, undefined, 'E2E worker failed to start');
          assert.equal(result.code, 0, `E2E worker cleanup failed: ${output}`);
        }
      }
    } finally {
      await children.stopAll();
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runBrowserApprovalE2ECases().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
