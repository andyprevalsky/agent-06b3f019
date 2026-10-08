import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { coalesceHubRunPuts } from '../../providers/benchmarkHubInFlight';

type Operation = () => Promise<unknown>;
type Admission = 'foreground' | 'snapshot';
type Owner = (operation: Operation, admission?: Admission) => Promise<unknown>;
type Transaction = { $executeRaw: (sql: TemplateStringsArray, key: string) => Promise<void> };
type Prisma = {
  $transaction: (body: (tx: Transaction) => Promise<unknown>, options: unknown) => Promise<unknown>;
};

/** Execute the actual storage owner's admission and transaction boundary. */
function loadOwner(prisma: Prisma): Owner {
  return loadDeclaration('withIndexLock', { prisma, Promise });
}

/** Include the owner's reachable declarations, replacing only external boundaries. */
function loadDeclaration<T>(name: string, bindings: Record<string, unknown>): T {
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
  assert.ok(included.has(named.get(name)!));
  const declarations = statements.filter((node) => included.has(node));
  const compiled = ts.transpileModule(
    declarations.map((node) => node.getText()).join('\n') + `\nglobalThis.owner = ${name};`,
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

test('queued foreground Hub work is admitted ahead of queued live snapshots', async () => {
  const database = databaseBoundary(4);
  const owner = loadOwner(database.prisma);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted: string[] = [];
  const run = (label: string, admission?: Admission) =>
    owner(async () => {
      admitted.push(label);
      if (label === 'holder') await gate;
      return label;
    }, admission);
  const outcomes = Promise.all([
    run('holder', 'snapshot'),
    run('snapshot-1', 'snapshot'),
    run('snapshot-2', 'snapshot'),
    run('final-1', 'foreground'),
    run('index-read'),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(admitted, ['holder']);
  release?.();
  assert.deepEqual(await outcomes, ['holder', 'snapshot-1', 'snapshot-2', 'final-1', 'index-read']);
  assert.deepEqual(admitted, ['holder', 'final-1', 'index-read', 'snapshot-1', 'snapshot-2']);
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
  const results = await Promise.all([
    boundary.putRun(packet, { live: true, source: 'fixture' }),
    boundary.putRun({ ...packet, marker: 'changed' }, { live: true, source: 'fixture' }),
    boundary.putRun({ ...packet, run_id: 'fixture-other' }, { live: true, source: 'fixture' }),
    boundary.putRun(packet, { live: true, source: 'other-source' }),
  ]);
  // A final is admitted ahead of queued snapshots and absorbs its run's later
  // ones, so live mode is distinguished against one pending identical snapshot.
  const modes = await Promise.all([
    boundary.putRun(packet, { live: true, source: 'fixture' }),
    boundary.putRun(packet, { live: false, source: 'fixture' }),
  ]);
  assert.equal(boundary.stats().transactions, 6);
  assert.deepEqual(
    boundary.runWrites().map(({ value }) => JSON.parse(value)),
    [
      packet,
      { ...packet, marker: 'changed' },
      { ...packet, run_id: 'fixture-other' },
      packet,
      packet,
      packet,
    ]
  );
  assert.equal(results[3].source, 'other-source');
  assert.deepEqual(
    modes.map((mode) => mode.live),
    [true, false]
  );
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

test('nonconsecutive identical packets preserve actual A B A storage order', async (context) => {
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
  const second = boundary.putRun(
    { ...packet, marker: 'changed' },
    { live: true, source: 'fixture' }
  );
  const last = boundary.putRun(JSON.parse(JSON.stringify(packet)), {
    live: true,
    source: 'fixture',
  });
  gate.resolve();
  await Promise.all([first, second, last]);
  const persisted = JSON.parse(boundary.objects.get(`runs/${packet.run_id}.json`)!);
  context.diagnostic(
    JSON.stringify({
      control: 'actual A B A storage',
      firstAndLastSharePromise: first === last,
      actualRunWrites: boundary.runWrites().length,
      finalPacketIsLastA: JSON.stringify(persisted) === JSON.stringify(packet),
    })
  );
  assert.deepEqual(
    boundary.runWrites().map(({ value }) => JSON.parse(value)),
    [packet, { ...packet, marker: 'changed' }, packet]
  );
  assert.deepEqual(persisted, packet);
  assert.notEqual(last, first);
});

for (const mode of ['source', 'live'] as const) {
  test(`an intervening same-run ${mode} change admits the final identical packet`, async () => {
    const entered = deferred();
    const gate = deferred();
    const boundary = putBoundary(async (key) => {
      if (key.startsWith('runs/')) {
        entered.resolve();
        await gate.promise;
      }
    });
    const options = { live: mode === 'source', source: 'fixture' };
    const first = boundary.putRun(packet, options);
    await entered.promise;
    const second = boundary.putRun(
      packet,
      mode === 'source' ? { ...options, source: 'other-source' } : { ...options, live: true }
    );
    const last = boundary.putRun(JSON.parse(JSON.stringify(packet)), options);
    gate.resolve();
    const results = await Promise.all([first, second, last]);
    assert.notEqual(last, first);
    assert.equal(boundary.stats().transactions, 3);
    assert.equal(boundary.runWrites().length, mode === 'source' ? 3 : 2);
    assert.equal(results[2].source, 'fixture');
    assert.equal(results[2].live, options.live);
    assert.deepEqual(JSON.parse(boundary.objects.get(`runs/${packet.run_id}.json`)!), packet);
  });
}

for (const fails of [false, true]) {
  test(`an earlier ${fails ? 'rejection' : 'success'} cannot evict the latest pending packet`, async () => {
    const entered = deferred();
    const firstGate = deferred();
    const secondGate = deferred();
    const marker = new Error('fixture earlier write failure');
    let runWrites = 0;
    const boundary = putBoundary(async (key) => {
      if (!key.startsWith('runs/')) return;
      runWrites += 1;
      if (runWrites === 1) {
        entered.resolve();
        await firstGate.promise;
        if (fails) throw marker;
      }
      if (runWrites === 2) await secondGate.promise;
    });
    const first = boundary.putRun(packet, { live: true, source: 'fixture' });
    const firstOutcome = first.then(
      () => undefined,
      (error: unknown) => error
    );
    await entered.promise;
    const second = boundary.putRun(
      { ...packet, marker: 'changed' },
      { live: true, source: 'fixture' }
    );
    const last = boundary.putRun(JSON.parse(JSON.stringify(packet)), {
      live: true,
      source: 'fixture',
    });
    const lastOutcome = last.then(
      () => undefined,
      (error: unknown) => error
    );
    firstGate.resolve();
    const firstResult = await firstOutcome;
    const peer = boundary.putRun(JSON.parse(JSON.stringify(packet)), {
      live: true,
      source: 'fixture',
    });
    const outcomes = Promise.allSettled([second, last, peer]);
    secondGate.resolve();
    const results = await outcomes;
    assert.equal(firstResult, fails ? marker : undefined);
    assert.equal(peer, last);
    assert.equal(await lastOutcome, undefined);
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    assert.equal(boundary.stats().transactions, 3);
    assert.equal(boundary.runWrites().length, fails ? 2 : 3);
    assert.deepEqual(JSON.parse(boundary.objects.get(`runs/${packet.run_id}.json`)!), packet);
  });
}

test('a different run preserves consecutive duplicate sharing for the first run', async () => {
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
  const other = boundary.putRun(
    { ...packet, run_id: 'fixture-other' },
    { live: true, source: 'fixture' }
  );
  const last = boundary.putRun(JSON.parse(JSON.stringify(packet)), {
    live: true,
    source: 'fixture',
  });
  gate.resolve();
  await Promise.all([first, other, last]);
  assert.equal(last, first);
  assert.equal(boundary.stats().transactions, 2);
  assert.equal(boundary.runWrites().length, 2);
});

test('coalescing follows the same normalized run identity as actual persistence', async () => {
  const entered = deferred();
  const gate = deferred();
  const boundary = putBoundary(async (key) => {
    if (key.startsWith('runs/')) {
      entered.resolve();
      await gate.promise;
    }
  });
  const firstPacket = { ...packet, run_id: 42 };
  const first = boundary.putRun(firstPacket, { live: true, source: 'fixture' });
  await entered.promise;
  const second = boundary.putRun(
    { ...firstPacket, run_id: '42', marker: 'changed' },
    { live: true, source: 'fixture' }
  );
  const last = boundary.putRun(JSON.parse(JSON.stringify(firstPacket)), {
    live: true,
    source: 'fixture',
  });
  gate.resolve();
  await Promise.all([first, second, last]);
  assert.notEqual(last, first);
  assert.equal(boundary.stats().transactions, 3);
  assert.equal(boundary.runWrites().length, 3);
  assert.deepEqual(JSON.parse(boundary.objects.get('runs/42.json')!), firstPacket);
});
