#!/usr/bin/env tsx

/**
 * Code-agent handoff contract (R3b, Andy 2026-10-24): the code agent returns its
 * result to the parent in one JSON file, and /close reads and consumes it.
 */
import assert from 'node:assert';
import {
  buildCodeAgentSystemPrompt,
  buildLocalCodeAgentSystemPrompt,
  CODE_AGENT_HANDOFF_PATH,
  CODE_AGENT_HANDOFF_SCHEMA_PATH,
} from '../../providers/codeAgentPrompt';
import { readCodeAgentHandoff } from '../../providers/e2bCloseSession';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

function fakeFiles(
  initial: Record<string, string>,
  failures: { read?: boolean; remove?: boolean } = {}
) {
  const store = new Map(Object.entries(initial));
  const removed: string[] = [];
  return {
    store,
    removed,
    files: {
      exists: async (path: string) => store.has(path),
      read: async (path: string) => {
        if (failures.read === true) throw new Error('sandbox read timed out');
        const value = store.get(path);
        if (value === undefined) throw new Error(`no such file ${path}`);
        return value;
      },
      remove: async (path: string) => {
        if (failures.remove === true) throw new Error('remove failed');
        removed.push(path);
        store.delete(path);
      },
    },
  };
}

async function main(): Promise<void> {
  await test('handoff path is the documented fixed path', () => {
    assert.strictEqual(CODE_AGENT_HANDOFF_PATH, '/home/user/.rose/handoff.json');
  });

  await test('present handoff is returned verbatim and consumed', async () => {
    const content = JSON.stringify({ total_steps: 111 });
    const sandbox = fakeFiles({ [CODE_AGENT_HANDOFF_PATH]: content });
    // The Pick<> the reader accepts is structurally satisfied by the fake.
    const handoff = await readCodeAgentHandoff(
      sandbox.files as unknown as Parameters<typeof readCodeAgentHandoff>[0]
    );
    assert.deepStrictEqual(handoff, { status: 'present', content });
    assert.deepStrictEqual(sandbox.removed, [CODE_AGENT_HANDOFF_PATH]);
    // A later spawn in the same persistent sandbox never sees this result.
    const again = await readCodeAgentHandoff(
      sandbox.files as unknown as Parameters<typeof readCodeAgentHandoff>[0]
    );
    assert.deepStrictEqual(again, { status: 'missing' });
  });

  await test('missing handoff is reported as missing', async () => {
    const sandbox = fakeFiles({});
    const handoff = await readCodeAgentHandoff(
      sandbox.files as unknown as Parameters<typeof readCodeAgentHandoff>[0]
    );
    assert.deepStrictEqual(handoff, { status: 'missing' });
  });

  await test('read failure is reported as unreadable with its cause', async () => {
    const sandbox = fakeFiles({ [CODE_AGENT_HANDOFF_PATH]: '{}' }, { read: true });
    const handoff = await readCodeAgentHandoff(
      sandbox.files as unknown as Parameters<typeof readCodeAgentHandoff>[0]
    );
    assert.deepStrictEqual(handoff, { status: 'unreadable', error: 'sandbox read timed out' });
  });

  await test('a failed consume still returns the handoff that was read', async () => {
    const sandbox = fakeFiles({ [CODE_AGENT_HANDOFF_PATH]: '{"a":1}' }, { remove: true });
    const handoff = await readCodeAgentHandoff(
      sandbox.files as unknown as Parameters<typeof readCodeAgentHandoff>[0]
    );
    assert.deepStrictEqual(handoff, { status: 'present', content: '{"a":1}' });
  });

  await test('E2B code-agent prompt states the handoff contract; the Mac prompt does not', () => {
    for (const roseDesktop of [false, true]) {
      const prompt = buildCodeAgentSystemPrompt({ roseDesktop });
      assert.ok(prompt.includes('Result handoff:'), 'handoff section missing');
      assert.ok(prompt.includes(CODE_AGENT_HANDOFF_PATH), 'handoff path missing');
    }
    assert.ok(!buildLocalCodeAgentSystemPrompt().includes(CODE_AGENT_HANDOFF_PATH));
  });

  // Andy 2026-11-08 (root 0874662a): every task is a goal ending in the handoff,
  // with standard outcome/git fields, no questions, and no unrequested merges.
  await test('E2B code-agent prompt: goal end condition, standard fields, no questions, ship only when asked', () => {
    for (const roseDesktop of [false, true]) {
      const prompt = buildCodeAgentSystemPrompt({ roseDesktop });
      assert.ok(prompt.includes('Your task is a goal.'), 'goal framing missing');
      assert.ok(prompt.includes(CODE_AGENT_HANDOFF_SCHEMA_PATH), 'schema path missing');
      assert.ok(prompt.includes('rose_handoff'), 'standard fields missing');
      assert.ok(
        prompt.includes('Do not ask questions; nobody answers them.'),
        'no-questions rule missing'
      );
      assert.ok(
        !/question/i.test(prompt.split('Do not ask questions')[0]),
        'questions mentioned as a field'
      );
      assert.ok(
        prompt.includes('only when your task or the user asks you to publish or ship'),
        'merge rule missing'
      );
    }
    assert.ok(
      buildLocalCodeAgentSystemPrompt().includes(
        'only when your task or the user asks you to publish or ship'
      )
    );
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    process.exit(1);
  }
}

void main();
