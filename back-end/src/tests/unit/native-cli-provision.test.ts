import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { CodeSessionRow } from '../../providers/codeSessions/store';

async function main() {
  let resume = true;
  let rootReads = 0;
  let creates = 0;
  let recorded = 0;
  let missing = false;
  const held = { sandboxId: 'held', commands: { run: async () => ({}) } };
  const fresh = { sandboxId: 'fresh' };
  await mock.module('../../providers/codeSessions/lifecycle', {
    namedExports: {
      connectPausedSandbox: async () => (resume ? held : null),
      checkpointCodeSession: async () => null,
      prepareLocalCodeSessionHome: async () => undefined,
      restoreLatestCheckpoint: async () => null,
    },
  });
  await mock.module('../../providers/codeSessions/store', {
    namedExports: {
      recordSandbox: async () => {
        recorded++;
      },
      linkClaudeCodeSession: async () => undefined,
      markPaused: async () => undefined,
    },
  });
  await mock.module('../../providers/codeSessions/sandboxSize', {
    namedExports: {
      resolveSpawnSandbox: async () => ({ size: { cpu: 2, memoryGb: 4 }, templateId: 'base-v1' }),
      heldSandboxSize: () => ({ cpu: 2, memoryGb: 4 }),
      sameSize: () => true,
      defaultSandboxSize: () => ({ cpu: 2, memoryGb: 4 }),
    },
  });
  await mock.module('../../providers/nativeCliTemplateBuilder', {
    namedExports: {
      NATIVE_CLI_PATH: '/fixture/native/bin:/usr/bin',
      resolveNativeCliTemplate: async (...args: unknown[]) => {
        rootReads++;
        assert.deepEqual(args, ['owner', 'claude', { cpu: 2, memoryGb: 4 }, 'base-v1']);
        if (missing) throw new Error('native variant missing');
        return 'snapshot-v1';
      },
    },
  });
  await mock.module('../../providers/e2bSandboxCreate', {
    namedExports: {
      createSandboxWithRetry: async (
        template: string,
        options: { envs: Record<string, string> }
      ) => {
        creates++;
        assert.equal(template, 'snapshot-v1');
        assert.equal(options.envs.PATH, '/fixture/native/bin:/usr/bin');
        assert.equal(options.envs.AUTH_FOR_CURRENT_AGENT, 'runtime-only');
        return fresh;
      },
    },
  });
  const { acquireCodeSandbox } = await import('../../providers/e2bCodeSessionSandbox');
  const session = {
    id: 'session',
    userId: 'owner',
    sandboxKind: 'e2b',
    sandboxId: 'held',
    cliSessionId: 'prior-conversation',
    latestCheckpointSeq: 0,
  } as CodeSessionRow;
  const invoke = () =>
    acquireCodeSandbox(session, 'fallback', { AUTH_FOR_CURRENT_AGENT: 'runtime-only' }, 'fixture', {
      provider: 'claude',
    });
  const resumed = await invoke();
  assert.equal(resumed.sandbox, held);
  assert.equal(resumed.cliSessionId, 'prior-conversation');
  assert.equal(rootReads, 0, 'resuming an existing sandbox does not consult or change its root');
  assert.equal(creates, 0);
  resume = false;
  const created = await invoke();
  assert.equal(created.sandbox, fresh);
  assert.equal(created.resumedFrom, 'new');
  assert.equal(rootReads, 1);
  assert.equal(creates, 1);
  assert.equal(recorded, 1);
  missing = true;
  await assert.rejects(invoke(), /native variant missing/);
  assert.equal(creates, 1, 'a missing published variant does not allocate an unconfigured base');
  process.stdout.write(
    'Native CLI provision: resumes unchanged, new allocation selects native root and live auth, missing variant fails closed\n'
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
