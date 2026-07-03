#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import { Sandbox } from 'e2b';
import {
  closeClaudeCodeSession,
  connectToSandbox,
  getClaudeCodeSession,
  getClaudeCodeSessionBySandboxId,
  parseClaudeCodeUsage,
} from '../../providers/e2bCloseSession';
import { prisma } from '../../providers/database';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  return fn().finally(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

async function main(): Promise<void> {
  await test('parseClaudeCodeUsage accumulates top-level and nested usage JSONL', () => {
    const usage = parseClaudeCodeUsage(
      [
        JSON.stringify({
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2,
          },
        }),
        'not-json',
        JSON.stringify({
          message: {
            usage: {
              input_tokens: 7,
              output_tokens: 5,
              cache_read_input_tokens: 1,
              cache_creation_input_tokens: 8,
            },
          },
        }),
        JSON.stringify({ usage: { input_tokens: 'ignored', output_tokens: Number.NaN } }),
      ].join('\n')
    );

    assert.deepStrictEqual(usage, {
      inputTokens: 17,
      outputTokens: 8,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 10,
    });
  });

  await test('connectToSandbox fails loudly when E2B_API_KEY is missing', async () => {
    await withEnv('E2B_API_KEY', undefined, async () => {
      await assert.rejects(connectToSandbox('sandbox-missing-key'), /E2B_API_KEY not configured/);
    });
  });

  await test('closeClaudeCodeSession reports missing sessions before touching E2B', async () => {
    await assert.rejects(
      closeClaudeCodeSession(`missing-${Date.now()}`),
      /Claude Code session not found/
    );
  });

  await test('closeClaudeCodeSession extracts JSONL usage and marks the session closed', async () => {
    const id = `unit-close-${Date.now()}`;
    const sandboxId = `sandbox-${id}`;
    const originalConnect = Sandbox.connect;
    const commands = {
      run: async (command: string): Promise<{ stdout: string }> => {
        assert.match(command, /find \/home\/user\/\.claude\/projects/);
        return { stdout: '/home/user/.claude/projects/session.jsonl\n' };
      },
    };
    const files = {
      read: async (path: string, options: { format: string }): Promise<string> => {
        assert.strictEqual(path, '/home/user/.claude/projects/session.jsonl');
        assert.strictEqual(options.format, 'text');
        return [
          JSON.stringify({ usage: { input_tokens: 20, output_tokens: 9 } }),
          JSON.stringify({
            message: {
              usage: {
                input_tokens: 3,
                output_tokens: 4,
                cache_read_input_tokens: 6,
                cache_creation_input_tokens: 7,
              },
            },
          }),
        ].join('\n');
      },
    };
    let killed = false;
    const mockSandbox = {
      commands,
      files,
      kill: async (): Promise<void> => {
        killed = true;
      },
    } as unknown as Awaited<ReturnType<typeof Sandbox.connect>>;

    Object.defineProperty(Sandbox, 'connect', {
      value: async (
        connectedSandboxId: string,
        options: { apiKey?: string }
      ): Promise<typeof mockSandbox> => {
        assert.strictEqual(connectedSandboxId, sandboxId);
        assert.strictEqual(options.apiKey, 'unit-e2b-key');
        return mockSandbox;
      },
      configurable: true,
    });

    try {
      await prisma.claudeCodeSession.create({
        data: {
          id,
          agentId: `agent-${id}`,
          sandboxId,
          goal: 'unit test close session',
          status: 'ACTIVE',
        },
      });

      assert.strictEqual((await getClaudeCodeSession(id))?.sandboxId, sandboxId);
      assert.strictEqual((await getClaudeCodeSessionBySandboxId(sandboxId))?.id, id);

      await withEnv('E2B_API_KEY', 'unit-e2b-key', async () => {
        const result = await closeClaudeCodeSession(id);
        assert.deepStrictEqual(result.outputFiles, []);
        assert.deepStrictEqual(result.usage, {
          inputTokens: 23,
          outputTokens: 13,
          cacheReadInputTokens: 6,
          cacheCreationInputTokens: 7,
        });
      });

      const session = await prisma.claudeCodeSession.findUnique({ where: { id } });
      assert.strictEqual(session?.status, 'CLOSED');
      assert.ok(session?.closedAt instanceof Date);
      assert.strictEqual(killed, true);
    } finally {
      Object.defineProperty(Sandbox, 'connect', { value: originalConnect, configurable: true });
      await prisma.claudeCodeSession.deleteMany({ where: { id } });
    }
  });

  await test('closeClaudeCodeSession closes cleanly when no JSONL usage logs exist', async () => {
    const id = `unit-close-empty-${Date.now()}`;
    const sandboxId = `sandbox-${id}`;
    const originalConnect = Sandbox.connect;
    let killed = false;
    const mockSandbox = {
      commands: {
        run: async (command: string): Promise<{ stdout: string }> => {
          assert.match(command, /find \/home\/user\/\.claude\/projects/);
          return { stdout: '' };
        },
      },
      files: {
        read: async (): Promise<string> => {
          throw new Error('files.read should not be called without JSONL paths');
        },
      },
      kill: async (): Promise<void> => {
        killed = true;
      },
    } as unknown as Awaited<ReturnType<typeof Sandbox.connect>>;

    Object.defineProperty(Sandbox, 'connect', {
      value: async (): Promise<typeof mockSandbox> => mockSandbox,
      configurable: true,
    });

    try {
      await prisma.claudeCodeSession.create({
        data: {
          id,
          agentId: `agent-${id}`,
          sandboxId,
          goal: 'unit test close session without usage logs',
          status: 'ACTIVE',
        },
      });

      await withEnv('E2B_API_KEY', 'unit-e2b-key', async () => {
        const result = await closeClaudeCodeSession(id);
        assert.deepStrictEqual(result.outputFiles, []);
        assert.strictEqual(result.usage, undefined);
      });

      const session = await prisma.claudeCodeSession.findUnique({ where: { id } });
      assert.strictEqual(session?.status, 'CLOSED');
      assert.strictEqual(killed, true);
    } finally {
      Object.defineProperty(Sandbox, 'connect', { value: originalConnect, configurable: true });
      await prisma.claudeCodeSession.deleteMany({ where: { id } });
    }
  });

  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`\n${passed}/5 E2B close-session tests passed`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
