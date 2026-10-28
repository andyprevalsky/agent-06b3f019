import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TemplateRecipe, TemplateVariant } from '../../providers/userCodeTemplates';

async function main() {
  await mock.module('../../providers/userCodeTemplates', {
    namedExports: { readUserCodeTemplate: async () => null },
  });
  const {
    buildNativeCliTemplate,
    resolveNativeCliTemplate,
    selectNativeCliTemplate,
    NATIVE_CLI_PATH,
  } = await import('../../providers/nativeCliTemplateBuilder');
  const recipe: TemplateRecipe = {
    id: 'fixture',
    name: 'Fixture CLI',
    install: 'mkdir -p /home/user/bin\nprintf fixture > /home/user/bin/fixture',
    command: '/home/user/bin/fixture',
    verify: ['--version'],
  };
  const variant: TemplateVariant = {
    key: 'claude:2:4',
    provider: 'claude',
    cpu: 2,
    memoryGb: 4,
    baseTemplateId: 'base-v1',
    snapshotId: 'snapshot-v1',
  };
  let killed = 0;
  let failure: 'install' | 'snapshot' | 'cleanup' | null = null;
  const commands: string[] = [];
  const snapshots: unknown[] = [];
  const sandbox = {
    sandboxId: 'owned-builder',
    commands: {
      run: async (command: string) => {
        commands.push(command);
        if (failure === 'install') throw new Error('secret-auth-value-from-process-output');
      },
    },
    createSnapshot: async (options: unknown) => {
      snapshots.push(options);
      if (failure === 'snapshot') throw new Error('filesystem-only disabled');
      return { snapshotId: 'immutable-snapshot' };
    },
    kill: async () => {
      killed++;
      if (failure === 'cleanup') throw new Error('secret-provider-detail');
    },
  };
  const create: Parameters<typeof buildNativeCliTemplate>[3] = async (template, options) => {
    assert.equal(template, 'base-v1');
    assert.deepEqual(options?.envs, { HOME: '/home/user', PATH: NATIVE_CLI_PATH, LANG: 'C.UTF-8' });
    return sandbox;
  };
  assert.equal(
    await buildNativeCliTemplate([recipe], variant, 'unique-operation', create),
    'immutable-snapshot'
  );
  assert.equal(killed, 1);
  assert.equal(commands.length, 2);
  assert(commands.every((command) => command.startsWith('env -i HOME=/home/user PATH=')));
  assert(commands[1].includes('/home/user/bin/fixture'));
  assert(commands[1].includes('--version'));
  assert.deepEqual(snapshots, [{ name: 'unique-operation', mode: 'filesystem', retries: 0 }]);

  failure = 'install';
  await assert.rejects(
    buildNativeCliTemplate([recipe], variant, 'failed-install', create),
    (error: Error) => {
      assert.equal(error.message, 'CLI template installation failed');
      return true;
    }
  );
  assert.equal(killed, 2);
  assert.equal(snapshots.length, 1, 'failed installation is never snapshotted');
  failure = 'snapshot';
  await assert.rejects(
    buildNativeCliTemplate([recipe], variant, 'unsupported-fs', create),
    /filesystem snapshot failed/
  );
  assert.equal(killed, 3);
  assert.equal(
    snapshots.length,
    2,
    'unsupported filesystem snapshots never retry as full snapshots'
  );
  failure = 'cleanup';
  await assert.rejects(
    buildNativeCliTemplate([recipe], variant, 'failed-cleanup', create),
    (error: Error) => {
      assert.equal(
        error.message,
        'CLI template builder cleanup failed: sandbox owned-builder, snapshot immutable-snapshot'
      );
      return true;
    }
  );
  assert.equal(killed, 4);

  // Exercise the actual generated shell boundary, including strict mode and argv quoting.
  failure = null;
  const scratch = mkdtempSync(join(tmpdir(), 'rose-native-cli-'));
  const executable = join(scratch, 'fixture');
  try {
    await buildNativeCliTemplate(
      [
        {
          ...recipe,
          command: executable,
          install: `printf '#!/bin/sh\\nprintf fixture-v1\\n' > '${executable}'\nchmod +x '${executable}'`,
        },
      ],
      variant,
      'shell-boundary',
      async () => ({
        ...sandbox,
        commands: {
          run: async (command: string) => {
            execFileSync('bash', ['-c', command]);
          },
        },
      })
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  assert.equal(
    selectNativeCliTemplate([variant], 'claude', { cpu: 2, memoryGb: 4 }, 'base-v1'),
    'snapshot-v1'
  );
  for (const mismatch of [
    { provider: 'codex' as const, size: { cpu: 2, memoryGb: 4 }, base: 'base-v1' },
    { provider: 'claude' as const, size: { cpu: 8, memoryGb: 4 }, base: 'base-v1' },
    { provider: 'claude' as const, size: { cpu: 2, memoryGb: 4 }, base: 'base-v2' },
  ]) {
    assert.throws(
      () => selectNativeCliTemplate([variant], mismatch.provider, mismatch.size, mismatch.base),
      /missing or stale/
    );
  }
  let reads = 0;
  const noHead = async (userId: string) => {
    reads++;
    assert.equal(userId, 'owner');
    return null;
  };
  assert.equal(
    await resolveNativeCliTemplate('owner', 'claude', { cpu: 2, memoryGb: 4 }, 'base-v1', noHead),
    'base-v1'
  );
  assert.equal(reads, 1);
  const initialHead = async () => ({
    kind: 'native-cli-template-v1' as const,
    revision: 0,
    recipes: [],
    variants: [],
  });
  assert.equal(
    await resolveNativeCliTemplate(
      'owner',
      'claude',
      { cpu: 2, memoryGb: 4 },
      'base-v1',
      initialHead
    ),
    'base-v1'
  );
  const existingHead = async () => ({
    kind: 'native-cli-template-v1' as const,
    revision: 1,
    recipes: [recipe],
    variants: [variant],
  });
  assert.equal(
    await resolveNativeCliTemplate(
      'owner',
      'claude',
      { cpu: 2, memoryGb: 4 },
      'base-v1',
      existingHead
    ),
    'snapshot-v1'
  );
  await assert.rejects(
    resolveNativeCliTemplate('owner', 'claude', { cpu: 2, memoryGb: 4 }, 'base-v2', existingHead),
    /missing or stale/
  );
  process.stdout.write(
    'Native CLI builder: clean env, immutable filesystem snapshot, owned cleanup, sanitized failures and exact variant provisioning passed\n'
  );
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
