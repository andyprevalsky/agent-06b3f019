import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

type Operation = () => Promise<unknown>;
type Admission = 'foreground' | 'snapshot';
type Owner = (operation: Operation, admission?: Admission) => Promise<unknown>;
type Transaction = { $executeRaw: (sql: TemplateStringsArray, key: string) => Promise<void> };
type Prisma = {
  $transaction: (body: (tx: Transaction) => Promise<unknown>, options: unknown) => Promise<unknown>;
};

/** Execute the actual storage owner's admission and transaction boundary. */
function loadOwner(prisma: Prisma): Owner {
  const filename = path.join(process.cwd(), 'src/providers/benchmarkHubStore.ts');
  const source = readFileSync(filename, 'utf8');
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const declarations = tree.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node)) return node.name?.text === 'withIndexLock';
    return (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((declaration) =>
        ['INDEX_LOCK_KEY', 'indexAdmissionWaiters', 'indexAdmissionHeld'].includes(
          declaration.name.getText(tree)
        )
      )
    );
  });
  assert.equal(declarations.filter(ts.isFunctionDeclaration).length, 1);
  const compiled = ts.transpileModule(
    declarations.map((node) => node.getText(tree)).join('\n') +
      '\nglobalThis.owner = withIndexLock;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
  ).outputText;
  const context = vm.createContext({ prisma, Promise });
  vm.runInContext(compiled, context);
  return context.owner;
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
