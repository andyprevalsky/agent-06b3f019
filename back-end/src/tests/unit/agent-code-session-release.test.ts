#!/usr/bin/env tsx
/**
 * releaseAgentCodeSessions closes a code session's row only once its sandbox is
 * gone. A row closed after a failed kill drops out of every later release (they
 * select ACTIVE rows), so the old Claude Code CLI kept running next to the
 * replacement until E2B's own timeout while its row reported a clean release.
 */

import assert from 'node:assert';
import { Sandbox } from 'e2b';
import { releaseAgentCodeSessions } from '../../providers/agentCleanup';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

async function withSandboxKill(
  kill: (sandboxId: string) => Promise<boolean>,
  fn: () => Promise<void>
): Promise<void> {
  const originalKill = Sandbox.kill;
  Object.defineProperty(Sandbox, 'kill', { value: kill, configurable: true });
  try {
    await fn();
  } finally {
    Object.defineProperty(Sandbox, 'kill', { value: originalKill, configurable: true });
  }
}

async function main(): Promise<void> {
  await test('a failed kill keeps the session ACTIVE until a later release kills it', async () => {
    const active = new Set(['failing', 'healthy']);
    let providerDown = true;
    const dependencies = {
      findActiveCodeSessions: async () => [...active].map((id) => ({ id, sandboxId: `sbx-${id}` })),
      killSandbox: async (session: { id: string }) => {
        if (providerDown && session.id === 'failing') throw new Error('E2B 502 Bad Gateway');
      },
      markClosed: async (sessionId: string) => {
        active.delete(sessionId);
      },
    };

    assert.strictEqual(await releaseAgentCodeSessions('agent-1', dependencies), 1);
    assert.deepStrictEqual([...active], ['failing'], 'only the killed sandbox may be closed');

    providerDown = false;
    assert.strictEqual(await releaseAgentCodeSessions('agent-1', dependencies), 1);
    assert.deepStrictEqual([...active], [], 'the next release must retry the failed kill');
  });

  await test('an E2B sandbox that is already gone is closed', async () => {
    const closed: string[] = [];
    await withSandboxKill(
      async () => false,
      async () => {
        const released = await releaseAgentCodeSessions('agent-2', {
          findActiveCodeSessions: async () => [{ id: 'expired', sandboxId: 'sbx-expired' }],
          markClosed: async (sessionId) => {
            closed.push(sessionId);
          },
        });
        assert.strictEqual(released, 1);
      }
    );
    assert.deepStrictEqual(closed, ['expired']);
  });

  await test('an E2B kill error leaves the session ACTIVE', async () => {
    const closed: string[] = [];
    const killed: string[] = [];
    await withSandboxKill(
      async (sandboxId) => {
        killed.push(sandboxId);
        throw new Error('fetch failed');
      },
      async () => {
        const released = await releaseAgentCodeSessions('agent-3', {
          findActiveCodeSessions: async () => [{ id: 'live', sandboxId: 'sbx-live' }],
          markClosed: async (sessionId) => {
            closed.push(sessionId);
          },
        });
        assert.strictEqual(released, 0);
      }
    );
    assert.deepStrictEqual(killed, ['sbx-live']);
    assert.deepStrictEqual(closed, []);
  });

  process.stdout.write(
    `\nagent code session release: ${passed} passed, ${failures.length} failed\n`
  );
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
