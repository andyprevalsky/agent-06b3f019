import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { Prisma } from '@prisma/client';

async function main() {
  await mock.module('../../providers/database', { namedExports: { prisma: {} } });
  await mock.module('../../providers/cliIntegrations', {
    namedExports: {
      CliIntegrationError: class extends Error {
        constructor(
          readonly status: number,
          message: string
        ) {
          super(message);
        }
      },
    },
  });
  const { withCliPublicationLease } = await import('../../providers/cliPublicationLease');
  let now = 100_000;
  let serial = 0;
  let row = {
    config: { kind: 'fixture' } as Prisma.JsonValue,
    status: 'SYNCING' as const,
    updatedAt: new Date(0),
  };
  const timers = new Set<() => void>();
  const deps = {
    now: () => now,
    token: () => `owner-${++serial}`,
    every: (fn: () => void) => {
      timers.add(fn);
      return () => {
        timers.delete(fn);
      };
    },
    read: async () => structuredClone(row),
    swap: async (expected: typeof row, config: Prisma.InputJsonObject) => {
      if (JSON.stringify(expected) !== JSON.stringify(row)) return false;
      row = { ...row, config: config as Prisma.JsonValue, updatedAt: new Date(now) };
      return true;
    },
  };
  const invoke = <T>(operation: Parameters<typeof withCliPublicationLease<T>>[2]) =>
    withCliPublicationLease('owner', 'connection', operation, deps);
  await invoke(async (_token, assertOwned) => {
    await assert.rejects(
      invoke(async () => undefined),
      /already running/
    );
    now += 70_000;
    for (const timer of timers) timer();
    await new Promise((done) => setImmediate(done));
    now += 70_000;
    await assertOwned();
    (row.config as Prisma.JsonObject).unrelated = 'preserve';
  });
  assert.deepEqual(row.config, { kind: 'fixture', unrelated: 'preserve' });
  assert.equal(timers.size, 0);
  row.config = { publishing_token: 'crashed', publishing_expires_at: now - 1 };
  await invoke(async (token) => {
    assert.notEqual(token, 'crashed');
  });
  row.config = { publishing_token: 'invalid', publishing_expires_at: 'later' };
  await assert.rejects(
    invoke(async () => undefined),
    /lease is invalid/
  );
  row.config = { publishing_token: 'legacy' };
  row.updatedAt = new Date(now);
  await assert.rejects(
    invoke(async () => undefined),
    /already running/
  );
  now += 24 * 60 * 60_000 + 1;
  await invoke(async () => undefined);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const predecessor = invoke(async (_token, assertOwned) => {
    entered();
    await blocked;
    await assertOwned();
  });
  await started;
  now += 90_001;
  await invoke(async (token) => {
    release();
    await assert.rejects(predecessor, /expired or was replaced/);
    assert.equal(
      (row.config as Prisma.JsonObject).publishing_token,
      token,
      'old release cannot erase successor'
    );
  });
  assert.equal(timers.size, 0);
  await invoke(async (_token, assertOwned, auth) => {
    await auth.beginAuth();
    assert.equal((row.config as Prisma.JsonObject).publishing_auth_inflight, true);
    await assertOwned();
    await auth.endAuth();
    assert.equal((row.config as Prisma.JsonObject).publishing_auth_inflight, undefined);
  });
  const uncertain = invoke(async (_token, _assertOwned, auth) => {
    await auth.beginAuth();
    now += 90_001;
    await assert.rejects(
      invoke(async () => undefined),
      /outcome is uncertain/
    );
    await auth.endAuth();
  });
  await assert.rejects(uncertain, /expired or was replaced/);
  const uncertainConfig = structuredClone(row.config);
  await assert.rejects(
    invoke(async () => undefined),
    /outcome is uncertain/
  );
  assert.deepEqual(
    row.config,
    uncertainConfig,
    'ambiguous authentication cannot be stolen or erased'
  );
  assert.equal(timers.size, 0);
  process.stdout.write(
    'CLI publication lease: renewal, crash takeover, legacy grace, and successor fencing passed\n'
  );
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
