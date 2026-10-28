import assert from 'node:assert/strict';
import {
  publishUserCodeTemplate,
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
  process.stdout.write(
    'Native templates: contention, immutable variants, recipe replay, failure retention, orphan receipts, stale fencing, renewal, idempotency and bounds passed\n'
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
