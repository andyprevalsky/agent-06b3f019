import assert from 'node:assert/strict';
import {
  publishUserCodeTemplate,
  repairUserCodeTemplateVariant,
  readUserCodeTemplate,
  UserCodeTemplateError,
  type UserCodeTemplate,
  type UserTemplateDependencies,
  type UserTemplateStore,
  type TemplateRecipe,
  type TemplateVariantDefinition,
} from '../../providers/userCodeTemplates';

const recipe = (id: string): TemplateRecipe => ({
  id,
  name: id,
  install: `install ${id}`,
  command: `/usr/bin/${id}`,
  verify: ['--version'],
});
const variants: TemplateVariantDefinition[] = [
  { key: 'claude:2:4:base-a', provider: 'claude', cpu: 2, memoryGb: 4, baseTemplateId: 'base-a' },
  { key: 'codex:8:16:base-b', provider: 'codex', cpu: 8, memoryGb: 16, baseTemplateId: 'base-b' },
];
function harness() {
  let head: UserCodeTemplate | null = null;
  let now = 0;
  let sequence = 0;
  const receipts = new Map<string, { fingerprint: string; revision: number }>();
  const ticks = new Set<() => void>();
  const store: UserTemplateStore = {
    read: async () => structuredClone(head),
    ensure: async () =>
      structuredClone(
        (head ??= { kind: 'native-cli-template-v1', revision: 0, recipes: [], variants: [] })
      ),
    receipt: async (_user, operation) => structuredClone(receipts.get(operation) ?? null),
    compareAndSet: async (_user, expected, next, receipt) => {
      if (JSON.stringify(head) !== JSON.stringify(expected)) return false;
      head = structuredClone(next);
      if (receipt) receipts.set(receipt.operationId, { ...receipt });
      return true;
    },
  };
  const deps: UserTemplateDependencies = {
    store,
    now: () => now,
    token: () => `attempt-${++sequence}`,
    every: (fn) => {
      ticks.add(fn);
      return () => {
        ticks.delete(fn);
      };
    },
  };
  return {
    deps,
    head: () => head,
    advance: (ms: number) => {
      now += ms;
    },
    tick: async () => {
      for (const fn of ticks) fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
async function rejection(run: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(
    run,
    (error: unknown) =>
      error instanceof UserCodeTemplateError && error.status === 409 && pattern.test(error.message)
  );
}
async function main() {
  const env = harness();
  assert.equal(await readUserCodeTemplate('owner', env.deps), null);
  const entered = gate();
  const release = gate();
  const names: string[] = [];
  const first = publishUserCodeTemplate(
    'owner',
    'op1',
    recipe('yc'),
    variants,
    async (recipes, variant, name) => {
      names.push(name);
      assert.equal(recipes[0].id, 'yc');
      if (variant.provider === 'claude') {
        entered.open();
        await release.promise;
      }
      return `snapshot-${name}`;
    },
    env.deps
  );
  await entered.promise;
  await rejection(
    publishUserCodeTemplate(
      'owner',
      'op2',
      recipe('gh'),
      variants,
      async () => 'must-not-build',
      env.deps
    ),
    /in progress/
  );
  assert.equal(env.head()?.revision, 0, 'readers keep previous revision while building');
  release.open();
  const published = await first;
  assert.equal(published.revision, 1);
  assert.equal(published.variants.length, 2);
  assert.equal(new Set(names).size, 2);
  assert.equal(published.lease, undefined);
  await rejection(
    publishUserCodeTemplate(
      'owner',
      'duplicate-command',
      { ...recipe('duplicate'), command: '/opt/yc' },
      variants,
      async () => 'must-not-build',
      env.deps
    ),
    /already connected/
  );
  let receiptReads = 0;
  const racedDeps = {
    ...env.deps,
    store: {
      ...env.deps.store,
      receipt: async (userId: string, operationId: string) =>
        ++receiptReads === 1 ? null : env.deps.store.receipt(userId, operationId),
    },
  };
  assert.equal(
    (
      await publishUserCodeTemplate(
        'owner',
        'op1',
        recipe('yc'),
        variants,
        async () => {
          throw new Error('must not rebuild a just-committed operation');
        },
        racedDeps
      )
    ).revision,
    1
  );
  const replay = await publishUserCodeTemplate(
    'owner',
    'op1',
    recipe('yc'),
    variants,
    async () => {
      throw new Error('must not rebuild committed op');
    },
    env.deps
  );
  assert.equal(replay.revision, 1);
  await rejection(
    publishUserCodeTemplate(
      'owner',
      'op1',
      recipe('different'),
      variants,
      async () => '',
      env.deps
    ),
    /different inputs/
  );
  await assert.rejects(
    publishUserCodeTemplate(
      'owner',
      'bad',
      recipe('gh'),
      variants,
      async (_recipes, variant) => {
        if (variant.provider === 'codex') throw new Error('build failed');
        return 'orphan-snapshot';
      },
      env.deps
    ),
    (error: unknown) =>
      error instanceof UserCodeTemplateError && error.orphanSnapshots.includes('orphan-snapshot')
  );
  assert.equal(env.head()?.revision, 1);
  assert.equal(env.head()?.recipes.length, 1);
  assert.equal(env.head()?.lease, undefined, 'failed builder releases only its own lease');
  const staleEntered = gate();
  const staleRelease = gate();
  const stale = publishUserCodeTemplate(
    'owner',
    'stale',
    recipe('old'),
    variants,
    async () => {
      staleEntered.open();
      await staleRelease.promise;
      return 'stale-snapshot';
    },
    env.deps
  );
  await staleEntered.promise;
  env.advance(100_000);
  const successor = await publishUserCodeTemplate(
    'owner',
    'successor',
    recipe('gh'),
    variants,
    async (recipes, variant, name) => {
      assert.deepEqual(
        recipes.map((item) => item.id),
        ['yc', 'gh'],
        'build every committed recipe on each clean variant'
      );
      assert.equal(variant.baseTemplateId, variant.provider === 'claude' ? 'base-a' : 'base-b');
      return name;
    },
    env.deps
  );
  staleRelease.open();
  await rejection(stale, /expired|replaced/);
  assert.deepEqual(env.head(), successor, 'expired writer cannot replace or unlock successor');
  const renew = harness();
  const renewEntered = gate();
  const renewRelease = gate();
  const longBuild = publishUserCodeTemplate(
    'owner',
    'long',
    recipe('yc'),
    [variants[0]],
    async () => {
      renewEntered.open();
      await renewRelease.promise;
      return 'renewed-snapshot';
    },
    renew.deps
  );
  await renewEntered.promise;
  renew.advance(50_000);
  await renew.tick();
  renew.advance(50_000);
  await renew.tick();
  renewRelease.open();
  assert.equal((await longBuild).revision, 1, 'long builds renew leases without losing fencing');
  const replaced = await publishUserCodeTemplate(
    'owner',
    'replacement',
    { ...recipe('yc'), install: 'new install' },
    variants,
    async (recipes) => {
      assert.equal(recipes.length, 1);
      assert.equal(recipes[0].install, 'new install');
      return 'replacement';
    },
    renew.deps
  );
  assert.equal(replaced.recipes.length, 1);
  await assert.rejects(
    publishUserCodeTemplate(
      'owner',
      'too-many',
      recipe('x'),
      Array.from({ length: 19 }, (_, i) => ({ ...variants[0], key: String(i) })),
      async () => '',
      env.deps
    ),
    /Invalid native CLI template variants/
  );
  const repairs = harness();
  await publishUserCodeTemplate(
    'owner',
    'seed-yc',
    recipe('yc'),
    variants,
    async (_r, v) => `old-${v.provider}`,
    repairs.deps
  );
  await publishUserCodeTemplate(
    'owner',
    'seed-gh',
    recipe('gh'),
    variants,
    async (_r, v) => `old-${v.provider}`,
    repairs.deps
  );
  const rotated = { ...variants[0], baseTemplateId: 'base-new' };
  let builds = 0;
  const repaired = await repairUserCodeTemplateVariant(
    'owner',
    rotated,
    async (recipes, variant) => {
      builds++;
      assert.deepEqual(
        recipes.map((item) => item.id),
        ['yc', 'gh']
      );
      assert.deepEqual(variant, rotated);
      return 'repaired-claude';
    },
    repairs.deps
  );
  assert.equal(builds, 1);
  assert.deepEqual(repaired.variants.map((item) => item.snapshotId).sort(), [
    'old-codex',
    'repaired-claude',
  ]);
  await repairUserCodeTemplateVariant(
    'owner',
    rotated,
    async () => {
      throw new Error('must reuse');
    },
    repairs.deps
  );
  const beforeFailure = structuredClone(repairs.head());
  await assert.rejects(
    repairUserCodeTemplateVariant(
      'owner',
      { ...rotated, key: 'new-size', cpu: 16 },
      async () => {
        throw new Error('build failed');
      },
      repairs.deps
    ),
    /build failed/
  );
  assert.deepEqual(repairs.head(), beforeFailure);
  const repairEntered = gate();
  const repairRelease = gate();
  const pendingRepair = repairUserCodeTemplateVariant(
    'owner',
    { ...rotated, key: 'new-size', cpu: 16 },
    async () => {
      repairEntered.open();
      await repairRelease.promise;
      return 'new-size';
    },
    repairs.deps
  );
  await repairEntered.promise;
  await rejection(
    publishUserCodeTemplate(
      'owner',
      'concurrent-add',
      recipe('new'),
      variants,
      async () => 'unreachable',
      repairs.deps
    ),
    /in progress/
  );
  repairRelease.open();
  assert.equal((await pendingRepair).variants.length, 3);
  // Same-user callers share a repair; another requested variant queues and retains it.
  const concurrent = harness();
  await publishUserCodeTemplate(
    'owner',
    'seed',
    recipe('yc'),
    variants,
    async (_r, v) => `old-${v.provider}`,
    concurrent.deps
  );
  const started = gate();
  const finish = gate();
  let concurrentBuilds = 0;
  const build = async () => {
    concurrentBuilds++;
    started.open();
    await finish.promise;
    return 'shared-new';
  };
  const firstRepair = repairUserCodeTemplateVariant('owner', rotated, build, concurrent.deps);
  await started.promise;
  const joined = repairUserCodeTemplateVariant('owner', rotated, build, concurrent.deps);
  const secondVariant = { ...variants[1], baseTemplateId: 'new-codex' };
  const queued = repairUserCodeTemplateVariant(
    'owner',
    secondVariant,
    async (recipes) => {
      assert.equal(recipes[0].id, 'yc');
      concurrentBuilds++;
      return 'new-codex';
    },
    concurrent.deps
  );
  finish.open();
  assert.equal((await firstRepair).revision, (await joined).revision);
  const finalHead = await queued;
  assert.equal(concurrentBuilds, 2);
  assert.deepEqual(finalHead.variants.map((v) => v.snapshotId).sort(), ['new-codex', 'shared-new']);

  // Another backend's store identity has its own queue but observes the same fenced head.
  const remote = harness();
  await publishUserCodeTemplate(
    'owner',
    'seed',
    recipe('yc'),
    variants,
    async (_r, v) => `old-${v.provider}`,
    remote.deps
  );
  const remoteStarted = gate();
  const remoteFinish = gate();
  const writer = repairUserCodeTemplateVariant(
    'owner',
    rotated,
    async () => {
      remoteStarted.open();
      await remoteFinish.promise;
      return 'remote-result';
    },
    remote.deps
  );
  await remoteStarted.promise;
  let polls = 0;
  const readerDeps = {
    ...remote.deps,
    store: { ...remote.deps.store },
    wait: async () => {
      polls++;
      remoteFinish.open();
      await writer;
    },
  };
  const observer = await repairUserCodeTemplateVariant(
    'owner',
    rotated,
    async () => {
      throw new Error('another backend must reuse the winner');
    },
    readerDeps
  );
  assert.equal(polls, 1);
  assert(observer.variants.some((v) => v.snapshotId === 'remote-result'));

  const held = {
    ...observer,
    lease: { token: 'remote', operationId: 'held', expiresAt: 99_999_999 },
  };
  const bounded = {
    ...remote.deps,
    store: { ...remote.deps.store, read: async () => held },
    wait: async (ms: number) => {
      remote.advance(ms);
    },
  };
  await assert.rejects(
    repairUserCodeTemplateVariant(
      'owner',
      secondVariant,
      async () => {
        throw new Error('must not build through held lease');
      },
      bounded
    ),
    /still in progress/
  );

  const fenced = harness();
  const baseSwap = fenced.deps.store.compareAndSet;
  let ownsIntegration = true;
  fenced.deps.store.compareAndSet = async (user, expected, next, receipt, fence) => {
    if (fence) {
      assert.deepEqual(fence, { integrationId: 'cli', token: 'current' });
      if (!ownsIntegration) return false;
    }
    return baseSwap(user, expected, next, receipt, fence);
  };
  await assert.rejects(
    publishUserCodeTemplate(
      'owner',
      'fenced',
      recipe('yc'),
      variants,
      async () => {
        ownsIntegration = false;
        return 'unpublished';
      },
      fenced.deps,
      { integrationId: 'cli', token: 'current' }
    ),
    /superseded/
  );
  assert.equal(fenced.head()?.revision, 0, 'lost integration owner cannot publish a head');
  process.stdout.write(
    'Native templates: contention, immutable variants, recipe replay, failure retention, orphan receipts, stale fencing, renewal, idempotency and bounds passed\n'
  );
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
