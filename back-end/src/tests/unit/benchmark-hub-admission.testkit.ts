import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {
  assertHubStorageOwnership,
  HUB_SQL_TIMEOUT_MS,
  withHubStorageOwnership,
} from '../../providers/benchmarkHubStorageOwnership';
import { coalesceHubRunPuts } from '../../providers/benchmarkHubInFlight';

export type Operation = () => Promise<unknown>;
export type Owner = (operation: Operation) => Promise<unknown>;
export type Transaction = {
  $executeRaw: (sql: TemplateStringsArray, key: string) => Promise<void>;
};
export type Prisma = {
  $transaction: (body: (tx: Transaction) => Promise<unknown>, options: unknown) => Promise<unknown>;
};

/** Execute the actual storage owner's admission and transaction boundary. */
export function loadOwner(prisma: Prisma): Owner {
  return loadDeclaration('withIndexLock', { prisma, Promise });
}

/** Include the owner's reachable declarations, replacing only external boundaries. */
export function loadDeclaration<T>(
  name: string,
  bindings: Record<string, unknown>,
  additional?: string
): T {
  const filename =
    process.env.BENCHMARK_HUB_OWNER_SOURCE_PATH ??
    path.join(process.cwd(), 'src/providers/benchmarkHubStore.ts');
  const source = readFileSync(filename, 'utf8');
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const groupFilename = path.join(path.dirname(filename), 'benchmarkHubRunProjection.ts');
  const grouped = tree.statements.some(
    (node) =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === './benchmarkHubRunProjection'
  );
  const statements = [
    ...tree.statements,
    ...(grouped
      ? ts.createSourceFile(
          groupFilename,
          readFileSync(groupFilename, 'utf8'),
          ts.ScriptTarget.Latest,
          true
        ).statements
      : []),
  ];
  const named = new Map<string, ts.Statement>();
  for (const node of statements) {
    if (ts.isFunctionDeclaration(node) && node.name) named.set(node.name.text, node);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        named.set(declaration.name.getText(), node);
      }
    }
  }
  const included = new Set<ts.Statement>();
  const include = (identifier: string): void => {
    if (Object.hasOwn(bindings, identifier)) return;
    const node = named.get(identifier);
    if (!node || included.has(node)) return;
    included.add(node);
    const visit = (child: ts.Node): void => {
      if (ts.isIdentifier(child)) include(child.text);
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
  };
  include(name);
  if (additional !== undefined) include(additional);
  assert.ok(included.has(named.get(name)!));
  const declarations = statements.filter((node) => included.has(node));
  const compiled = ts.transpileModule(
    declarations.map((node) => node.getText()).join('\n') +
      `\nglobalThis.owner = ${name};` +
      (additional === undefined ? '' : `\nglobalThis.extraOwner = ${additional};`),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }
  ).outputText;
  const context = vm.createContext({
    assertHubStorageOwnership,
    HUB_SQL_TIMEOUT_MS,
    withHubStorageOwnership,
    hubStorageDomain: () => 'benchmark-hub',
    hubWritesEnabled: () => true,
    ...bindings,
    exports: {},
  });
  vm.runInContext(compiled, context);
  if (additional !== undefined) context.owner.mutation = context.extraOwner;
  return context.owner;
}

export type Bundle = Record<string, unknown>;
export type PutRun = (
  bundle: Bundle,
  options?: { live?: boolean; source?: string }
) => Promise<Bundle>;

export function putBoundary(
  beforeWrite: (key: string) => Promise<void> = async () => {},
  beforeCommit: () => Promise<void> = async () => {},
  beforeTransaction: () => Promise<void> = async () => {}
) {
  const database = databaseBoundary(4);
  const objects = new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  let transactions = 0;
  let ancestors = 0;
  let cacheUpdates = 0;
  let revision = 0;
  const putRun = loadDeclaration<PutRun & { mutation: Owner }>(
    'putRun',
    {
      Promise,
      coalesceHubRunPuts,
      beginHubPublications: async () => {},
      hubStorageDomain: () => 'benchmark-hub',
      hubWritesEnabled: () => true,
      prisma: {
        $transaction: async (body: (tx: Transaction) => Promise<unknown>, options: unknown) => {
          transactions += 1;
          await beforeTransaction();
          const result = await database.prisma.$transaction(body, options);
          await beforeCommit();
          return result;
        },
      },
      listRunsStrict: async () => JSON.parse(objects.get('index.json') ?? '[]'),
      readAgentRunIndexForMutation: async () => ({ revision }),
      agentIdsFromHubBundle: () => ['fixture-agent'],
      hubAgentIndexAfterPut: () => ({ revision: ++revision }),
      putObject: async (key: string, value: string) => {
        await beforeWrite(key);
        writes.push({ key, value });
        objects.set(key, value);
      },
      writeAgentRunIndex: async () => {},
      slotHubAncestorSkeletonsFromBundle: async () => {
        ancestors += 1;
      },
      applyHubRunToResolutionCaches: () => {
        cacheUpdates += 1;
      },
      log: { info: () => {} },
    },
    'withIndexLock'
  );
  return {
    putRun,
    mutation: putRun.mutation,
    objects,
    runWrites: () => writes.filter(({ key }) => key.startsWith('runs/')),
    stats: () => ({
      transactions,
      ancestors,
      cacheUpdates,
      ...database.stats(),
    }),
  };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function databaseBoundary(capacity: number) {
  let tail: Promise<void> = Promise.resolve();
  let open = 0;
  let peakOpen = 0;
  let held = 0;
  let peakHeld = 0;
  const prisma: Prisma = {
    async $transaction(body, options) {
      assert.equal(JSON.stringify(options), JSON.stringify({ maxWait: 30_000, timeout: 300_000 }));
      if (open === capacity) throw new Error('fixture connection pool exhausted');
      open += 1;
      peakOpen = Math.max(peakOpen, open);
      let release: (() => void) | undefined;
      let acquired = false;
      try {
        return await body({
          async $executeRaw(sql, key) {
            assert.equal(sql.join('?'), 'SELECT pg_advisory_xact_lock(hashtext(?))');
            assert.equal(key, 'benchmark-hub:index');
            const previous = tail;
            tail = new Promise<void>((resolve) => {
              release = resolve;
            });
            await previous;
            acquired = true;
            held += 1;
            peakHeld = Math.max(peakHeld, held);
          },
        });
      } finally {
        if (acquired) held -= 1;
        release?.();
        open -= 1;
      }
    },
  };
  return { prisma, stats: () => ({ open, peakOpen, held, peakHeld }) };
}

export function registerCommitControls(): void {
  test('SQL commit failure rejects queued Hub callers after durable object writes', async () => {
    const marker = new Error('fixture SQL commit failed after callback');
    const boundary = putBoundary(
      async () => {},
      async () => {
        throw marker;
      }
    );
    const results = await Promise.allSettled(
      ['holder', 'a', 'b'].map((run_id) => boundary.putRun({ run_id, tasks: [] }, { live: true }))
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected', 'rejected']
    );
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.equal(result.reason, marker);
    }
    assert.ok(boundary.runWrites().length > 0, 'failure follows durable object writes');
    assert.equal(
      boundary.stats().cacheUpdates,
      0,
      'failed SQL commit must not publish cache state'
    );
    assert.equal(boundary.stats().ancestors, 0, 'failed SQL commit must not reach postcommit work');
  });

  test('Hub callers and caches remain pending until SQL commit succeeds', async () => {
    const entered = deferred();
    const commit = deferred();
    const boundary = putBoundary(
      async () => {},
      async () => {
        entered.resolve();
        await commit.promise;
      }
    );
    let settled = false;
    const pending = boundary.putRun({ run_id: 'pending-commit', tasks: [] }, { live: true });
    void pending.then(() => {
      settled = true;
    });
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'durable object writes alone are not a committed ACK');
    assert.equal(boundary.stats().cacheUpdates, 0);
    assert.equal(boundary.stats().ancestors, 0);
    commit.resolve();
    await pending;
    assert.equal(settled, true);
    assert.equal(boundary.stats().cacheUpdates, 1);
    assert.equal(boundary.stats().ancestors, 1);
  });

  test('queued PUT cohorts never cross earlier generic mutation barriers', async () => {
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    const boundary = putBoundary(async (key) => {
      if (key === 'runs/holder.json') {
        entered.resolve();
        await release.promise;
      }
      if (key.startsWith('runs/')) events.push(key);
    });
    const holder = boundary.putRun({ run_id: 'holder', tasks: [] });
    await entered.promise;
    const a = boundary.putRun({ run_id: 'a', tasks: [] });
    const genericA = boundary.mutation(async () => {
      events.push('generic-a');
    });
    const b = boundary.putRun({ run_id: 'b', tasks: [] });
    const genericB = boundary.mutation(async () => {
      events.push('generic-b');
    });
    const c = boundary.putRun({ run_id: 'c', tasks: [] });
    release.resolve();
    await Promise.all([holder, a, genericA, b, genericB, c]);
    assert.deepEqual(events, [
      'runs/holder.json',
      'runs/a.json',
      'generic-a',
      'runs/b.json',
      'generic-b',
      'runs/c.json',
    ]);
    assert.equal(boundary.stats().peakOpen, 1);
  });

  test('PUT cohorts spill above64 while retaining eight joined write lanes', async () => {
    const entered = deferred();
    const release = deferred();
    let active = 0;
    let peak = 0;
    const boundary = putBoundary(async (key) => {
      if (key === 'runs/holder.json') {
        entered.resolve();
        await release.promise;
        return;
      }
      if (!key.startsWith('runs/')) return;
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
    });
    const holder = boundary.putRun({ run_id: 'holder', tasks: [] });
    await entered.promise;
    const pending = Array.from({ length: 129 }, (_, i) =>
      boundary.putRun({ run_id: `spill-${i}`, tasks: [] })
    );
    release.resolve();
    await Promise.all([holder, ...pending]);
    assert.equal(boundary.stats().transactions, 4, 'one holder plus64/64/1 cohorts');
    assert.equal(boundary.runWrites().length, 130);
    assert.equal(peak, 8);
    assert.equal(active, 0);
    assert.equal(boundary.stats().peakOpen, 1);
  });

  test('failed PUT transaction acquisition clears only its cohort and a later cohort recovers', async () => {
    const gate = deferred();
    let fail = true;
    const marker = new Error('fixture PUT acquisition failed');
    const boundary = putBoundary(
      async () => {},
      async () => {},
      async () => {
        if (fail) {
          await gate.promise;
          throw marker;
        }
      }
    );
    const pending = ['a', 'b', 'c'].map((run_id) => boundary.putRun({ run_id, tasks: [] }));
    const done = Promise.allSettled(pending);
    gate.resolve();
    for (const result of await done) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.equal(result.reason, marker);
    }
    assert.equal(boundary.runWrites().length, 0);
    fail = false;
    await boundary.putRun({ run_id: 'recovered', tasks: [] });
    assert.equal(boundary.runWrites().length, 1);
    assert.equal(boundary.stats().cacheUpdates, 1);
  });

  test('a failed write joins every active lane before rejecting its cohort', async () => {
    const held = deferred();
    const release = deferred();
    const failed = deferred();
    const marker = new Error('fixture lane failed');
    let active = 0;
    const boundary = putBoundary(async (key) => {
      if (!key.startsWith('runs/')) return;
      active++;
      try {
        if (key === 'runs/a.json') {
          await held.promise;
          failed.resolve();
          throw marker;
        }
        held.resolve();
        await release.promise;
      } finally {
        active--;
      }
    });
    let settled = false;
    const done = Promise.allSettled(
      ['a', 'b', 'c'].map((run_id) => boundary.putRun({ run_id, tasks: [] }))
    ).then((results) => {
      settled = true;
      return results;
    });
    await failed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.ok(active > 0);
    release.resolve();
    const outcomes = await done;
    assert.ok(outcomes.every((result) => result.status === 'rejected' && result.reason === marker));
    assert.equal(active, 0);
    assert.equal(boundary.stats().cacheUpdates, 0);
  });
}
