import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { coalesceHubRunPuts } from '../../providers/benchmarkHubInFlight';

type Operation = () => Promise<unknown>;
type Transaction = { $executeRaw: (sql: TemplateStringsArray, key: string) => Promise<void> };
type Prisma = {
  $transaction: (body: (tx: Transaction) => Promise<unknown>, options: unknown) => Promise<unknown>;
};

/** Execute the actual storage owner's admission and transaction boundary. */
function loadOwner(prisma: Prisma): (operation: Operation) => Promise<unknown> {
  return loadDeclaration('withIndexLock', { prisma, Promise });
}

/** Include the owner's reachable declarations, replacing only external boundaries. */
function loadDeclaration<T>(name: string, bindings: Record<string, unknown>): T {
  const filename =
    process.env.BENCHMARK_HUB_OWNER_SOURCE_PATH ??
    path.join(process.cwd(), 'src/providers/benchmarkHubStore.ts');
  const source = readFileSync(filename, 'utf8');
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const named = new Map<string, ts.Statement>();
  for (const node of tree.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) named.set(node.name.text, node);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        named.set(declaration.name.getText(tree), node);
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
  assert.ok(included.has(named.get(name)!));
  const declarations = tree.statements.filter((node) => included.has(node));
  const compiled = ts.transpileModule(
    declarations.map((node) => node.getText(tree)).join('\n') + `\nglobalThis.owner = ${name};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
  ).outputText;
  const context = vm.createContext({ ...bindings, exports: {} });
  vm.runInContext(compiled, context);
  return context.owner;
}

type Bundle = Record<string, unknown>;
type PutRun = (bundle: Bundle, options?: { live?: boolean; source?: string }) => Promise<Bundle>;

function putBoundary(beforeWrite: (key: string) => Promise<void> = async () => {}) {
  const database = databaseBoundary(4);
  const objects = new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  let transactions = 0;
  let ancestors = 0;
  let cacheUpdates = 0;
  let revision = 0;
  const putRun = loadDeclaration<PutRun>('putRun', {
    Promise,
    coalesceHubRunPuts,
    prisma: {
      $transaction: (body: (tx: Transaction) => Promise<unknown>, options: unknown) => {
        transactions += 1;
        return database.prisma.$transaction(body, options);
      },
    },
    listRunsStrict: async () => JSON.parse(objects.get('index.json') ?? '[]'),
    readAgentRunIndexForMutation: async () => ({ revision }),
    agentIdsFromHubBundle: () => new Set(['fixture-agent']),
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
  });
  return {
    putRun,
    objects,
    runWrites: () => writes.filter(({ key }) => key.startsWith('runs/')),
    stats: () => ({ transactions, ancestors, cacheUpdates, ...database.stats() }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function databaseBoundary(capacity: number) {
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

test('50 Hub mutations wait for process admission before borrowing SQL connections', async () => {
  const database = databaseBoundary(4);
  const owner = loadOwner(database.prisma);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const results = Promise.allSettled(
    Array.from({ length: 50 }, (_, index) =>
      owner(async () => {
        await gate;
        return index;
      })
    )
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  release?.();
  const outcomes = await results;
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 50);
  assert.deepEqual(database.stats(), { open: 0, peakOpen: 1, held: 0, peakHeld: 1 });
});

test('a failed Hub mutation releases admission and preserves its rejection', async () => {
  const database = databaseBoundary(4);
  const owner = loadOwner(database.prisma);
  const marker = new Error('fixture storage failure');
  const outcomes = await Promise.allSettled([
    owner(async () => {
      throw marker;
    }),
    owner(async () => 'next mutation'),
  ]);
  assert.equal(outcomes[0].status, 'rejected');
  if (outcomes[0].status === 'rejected') assert.equal(outcomes[0].reason, marker);
  assert.deepEqual(outcomes[1], { status: 'fulfilled', value: 'next mutation' });
  assert.deepEqual(database.stats(), { open: 0, peakOpen: 1, held: 0, peakHeld: 1 });
});

test('failed transaction acquisition releases admission for the next caller', async () => {
  const database = databaseBoundary(4);
  const marker = new Error('fixture transaction acquisition failure');
  let acquisitions = 0;
  const owner = loadOwner({
    async $transaction(body, options) {
      acquisitions += 1;
      if (acquisitions === 1) throw marker;
      return database.prisma.$transaction(body, options);
    },
  });
  const outcomes = await Promise.allSettled([
    owner(async () => 'never admitted'),
    owner(async () => 'next mutation'),
  ]);
  assert.equal(outcomes[0].status, 'rejected');
  if (outcomes[0].status === 'rejected') assert.equal(outcomes[0].reason, marker);
  assert.deepEqual(outcomes[1], { status: 'fulfilled', value: 'next mutation' });
  assert.equal(acquisitions, 2);
  assert.deepEqual(database.stats(), { open: 0, peakOpen: 1, held: 0, peakHeld: 1 });
});

test('separate backend admissions still serialize through the shared PostgreSQL lock', async () => {
  const database = databaseBoundary(4);
  const owners = [loadOwner(database.prisma), loadOwner(database.prisma)];
  let inside = 0;
  let peakInside = 0;
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      owners[index % 2](async () => {
        inside += 1;
        peakInside = Math.max(peakInside, inside);
        await new Promise<void>((resolve) => setImmediate(resolve));
        inside -= 1;
        return index;
      })
    )
  );
  assert.equal(outcomes.length, 20);
  assert.equal(peakInside, 1);
  assert.deepEqual(database.stats(), { open: 0, peakOpen: 2, held: 0, peakHeld: 1 });
});

const packet = {
  run_id: 'fixture-identical',
  timestamp: '2026-10-06T11:55:18Z',
  tasks: [{ name: 'fixture-task', passed: null, status: 'starting' }],
};

test('50 identical pending Hub packets share one publication before SQL admission', async () => {
  const entered = deferred();
  const gate = deferred();
  const boundary = putBoundary(async (key) => {
    if (key.startsWith('runs/')) {
      entered.resolve();
      await gate.promise;
    }
  });
  const first = boundary.putRun(packet, { live: true, source: 'fixture' });
  await entered.promise;
  const requests = [
    first,
    ...Array.from({ length: 49 }, () =>
      boundary.putRun(JSON.parse(JSON.stringify(packet)), { live: true, source: 'fixture' })
    ),
  ];
  gate.resolve();
  const results = await Promise.all(requests);
  assert.equal(boundary.runWrites().length, 1);
  assert.equal(boundary.stats().transactions, 1);
  assert.equal(boundary.stats().ancestors, 1);
  assert.equal(boundary.stats().cacheUpdates, 1);
  assert.ok(requests.every((request) => request === first));
  assert.ok(results.every((result) => result === results[0]));
});

test('distinct packet content, run, source and live mode retain publication order', async () => {
  const boundary = putBoundary();
  const requests = [
    boundary.putRun(packet, { live: true, source: 'fixture' }),
    boundary.putRun({ ...packet, marker: 'changed' }, { live: true, source: 'fixture' }),
    boundary.putRun({ ...packet, run_id: 'fixture-other' }, { live: true, source: 'fixture' }),
    boundary.putRun(packet, { live: true, source: 'other-source' }),
    boundary.putRun(packet, { live: false, source: 'fixture' }),
  ];
  const results = await Promise.all(requests);
  assert.equal(boundary.stats().transactions, 5);
  assert.deepEqual(
    boundary.runWrites().map(({ value }) => JSON.parse(value)),
    [
      packet,
      { ...packet, marker: 'changed' },
      { ...packet, run_id: 'fixture-other' },
      packet,
      packet,
    ]
  );
  assert.equal(results[3].source, 'other-source');
  assert.equal(results[4].live, false);
});

test('failed identical publication rejects every waiter and permits an unchanged retry', async () => {
  const marker = new Error('fixture object write failure');
  let fail = true;
  const boundary = putBoundary(async (key) => {
    if (key.startsWith('runs/') && fail) throw marker;
  });
  const outcomes = await Promise.allSettled(
    Array.from({ length: 3 }, () => boundary.putRun(packet, { live: true }))
  );
  assert.ok(
    outcomes.every((outcome) => outcome.status === 'rejected' && outcome.reason === marker)
  );
  assert.equal(boundary.stats().transactions, 1);
  fail = false;
  assert.equal((await boundary.putRun(packet, { live: true })).run_id, packet.run_id);
  assert.equal(boundary.stats().transactions, 2);
  assert.equal(boundary.runWrites().length, 1);
});

test('settled packets are evicted and late live packets preserve the absorbing final state', async () => {
  const boundary = putBoundary();
  const first = await boundary.putRun(packet, { live: true });
  const second = await boundary.putRun(packet, { live: true });
  assert.notEqual(first, second);
  assert.equal(boundary.runWrites().length, 2);
  const terminalPacket = { ...packet, tasks: [{ name: 'fixture-task', passed: false }] };
  await boundary.putRun(terminalPacket, { live: false });
  const lateLive = await boundary.putRun(packet, { live: true });
  assert.equal(lateLive.live, false);
  assert.equal(boundary.runWrites().length, 3);
  assert.equal(boundary.stats().transactions, 4);
  assert.deepEqual(JSON.parse(boundary.objects.get(`runs/${packet.run_id}.json`)!), terminalPacket);
});
