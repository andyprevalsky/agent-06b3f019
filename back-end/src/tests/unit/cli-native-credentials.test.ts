import assert from 'node:assert/strict';
import { mock } from 'node:test';

let now = 1_000;
const clock = mock.method(Date, 'now', () => now);
let connectionStatus = 'SYNCING';
let state: Record<string, unknown> | null = null;
let native = true;
let live = true;
const paths = ['.yc/credentials.json'];
const db = {
  integration: {
    findFirst: async ({ where }: { where: { userId: string; id: string } }) =>
      where.userId === 'owner' && where.id === 'cli'
        ? {
            id: 'cli',
            status: connectionStatus,
            config: { native_template: native, command: '/usr/bin/yc', credential_files: paths },
          }
        : null,
    findUnique: async ({ where }: { where: { userId_name_accountId: { userId: string } } }) =>
      where.userId_name_accountId.userId === 'owner' && state
        ? { config: structuredClone(state) }
        : null,
    create: async ({ data }: { data: { config: Record<string, unknown> } }) => {
      state = structuredClone(data.config);
      return data;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { name: string; config?: { equals: unknown } };
      data: { config?: Record<string, unknown> };
    }) => {
      if (where.name === 'cli') return { count: connectionStatus === 'CONNECTED' ? 0 : 1 };
      if (JSON.stringify(where.config?.equals) !== JSON.stringify(state)) return { count: 0 };
      state = structuredClone(data.config!);
      return { count: 1 };
    },
  },
  claudeCodeSession: {
    findUnique: async () => ({ agentId: 'agent', status: live ? 'ACTIVE' : 'CLOSED' }),
  },
  agent: {
    findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
      where.id === 'agent' && where.userId === 'owner' ? { id: 'agent' } : null,
  },
};
const file = (text: string) => [{ path: paths[0], data: Buffer.from(text).toString('base64') }];
async function main() {
  await mock.module('../../providers/database', {
    namedExports: {
      prisma: db,
      runTransactionWithRetry: async (fn: (client: typeof db) => Promise<unknown>) => fn(db),
    },
  });
  await mock.module('../../providers/projects/secrets', {
    namedExports: {
      encryptProjectSecret: (text: string) => `encrypted:${Buffer.from(text).toString('base64')}`,
      decryptProjectSecret: (text: string) =>
        Buffer.from(text.slice('encrypted:'.length), 'base64').toString(),
    },
  });
  const credentials = await import('../../providers/cliNativeCredentials');
  for (const path of [
    '../token',
    '/token',
    '.rose/tools.json',
    '.config/.codex/auth.json',
    '.ssh/id_rsa',
    '.yc//token',
    '.yc/./token',
    '.yc/../token',
    '.yc\\token',
    '.bashrc',
    '~/.yc/token',
  ])
    assert.equal(credentials.isCliCredentialPath(path), false, path);
  assert.equal(credentials.isCliCredentialPath(paths[0]), true);
  assert.throws(
    () => credentials.validateCliCredentialFiles([{ path: paths[0], data: 'invalid!' }]),
    /encoding/
  );
  assert.throws(
    () => credentials.validateCliCredentialFiles([...file('a'), ...file('b')]),
    /Invalid/
  );
  assert.throws(() => credentials.validateCliCredentialFiles(file('a'.repeat(65_537))), /size/);
  assert.throws(
    () =>
      credentials.validateCliCredentialFiles(
        Array.from({ length: 5 }, (_, i) => ({
          path: `.yc/file${i}`,
          data: Buffer.alloc(65_536).toString('base64'),
        }))
      ),
    /size limit/
  );
  assert.equal(
    (await credentials.initializeCliCredentials('owner', 'cli', file('first-secret'))).initialized,
    true
  );
  assert(!JSON.stringify(state).includes('first-secret'));
  await credentials.initializeCliCredentials('owner', 'cli', file('setup-refresh'));
  connectionStatus = 'CONNECTED';
  assert.equal(
    (await credentials.initializeCliCredentials('owner', 'cli', file('stale-secret'))).initialized,
    false
  );
  await assert.rejects(
    credentials.initializeCliCredentials('owner', 'cli', [{ path: '.other/auth', data: '' }]),
    /paths/
  );
  const caller = { userId: 'owner', agentId: 'agent', taskId: 'task1' };
  await assert.rejects(
    credentials.acquireCliCredentials({ ...caller, userId: 'other' }, 'cli'),
    /not found/
  );
  live = false;
  await assert.rejects(credentials.acquireCliCredentials(caller, 'cli'), /live code session/);
  live = true;
  native = false;
  await assert.rejects(credentials.acquireCliCredentials(caller, 'cli'), /not configured/);
  native = true;
  const outcomes = await Promise.allSettled([
    credentials.acquireCliCredentials(caller, 'cli'),
    credentials.acquireCliCredentials(caller, 'cli'),
  ]);
  assert.equal(
    outcomes.filter((item) => item.status === 'fulfilled').length,
    1,
    'only one concurrent command acquires auth'
  );
  const winner = outcomes.find((item) => item.status === 'fulfilled');
  assert(winner?.status === 'fulfilled');
  const lease = winner.value;
  assert.equal(lease.command, '/usr/bin/yc');
  assert.deepEqual(lease.files, file('setup-refresh'));
  await assert.rejects(
    credentials.releaseCliCredentials(
      { ...caller, taskId: 'task2' },
      'cli',
      lease.lease_token,
      file('wrong')
    ),
    /does not belong/
  );
  now += 40_000;
  const heartbeat = await credentials.heartbeatCliCredentials(caller, 'cli', lease.lease_token);
  assert(heartbeat.expires_at > lease.expires_at);
  await assert.rejects(
    credentials.releaseCliCredentials(caller, 'cli', lease.lease_token, [
      { path: '.yc/wrong', data: '' },
    ]),
    /paths/
  );
  await credentials.releaseCliCredentials(caller, 'cli', lease.lease_token, file('rotated-secret'));
  const next = await credentials.acquireCliCredentials(caller, 'cli');
  assert.deepEqual(next.files, file('rotated-secret'));
  await credentials.releaseCliCredentials(caller, 'cli', next.lease_token, [
    { path: paths[0], data: null },
  ]);
  const deleted = await credentials.acquireCliCredentials(caller, 'cli');
  assert.deepEqual(deleted.files, [{ path: paths[0], data: null }]);
  now = deleted.expires_at;
  await assert.rejects(credentials.acquireCliCredentials(caller, 'cli'), /expired.*reconnect/);
  await assert.rejects(
    credentials.heartbeatCliCredentials(caller, 'cli', deleted.lease_token),
    /expired/
  );
  await assert.rejects(
    credentials.releaseCliCredentials(caller, 'cli', deleted.lease_token, file('late')),
    /expired/
  );
  clock.mock.restore();
  process.stdout.write(
    'Native CLI credentials: path/size validation, encrypted setup, ownership, concurrent leases, refreshed state, fencing and no expired stealing passed\n'
  );
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
