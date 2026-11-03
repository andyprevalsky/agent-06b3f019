import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type Curation = (options: {
  rootAgentIds: string[];
  concurrency?: number;
  deleteRejected?: boolean;
  onResult?: (value: unknown, index: number) => void;
}) => Promise<{ classification: { rootAgentId: string } }[]>;
function deferred() {
  let resolve: () => void = () => {
    throw new Error('uninitialized deferred');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
function loadOwner(
  audit: (id: string) => Promise<unknown>,
  remove: (id: string) => Promise<unknown>
): Curation {
  const filename = path.resolve(__dirname, '../../providers/traceArchiveCuration.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const owner = { exports: {} as { curateTraceArchives?: Curation } };
  const io = (name: string) => {
    if (name === './traceArchiveAudit') return { auditArchiveBundle: audit };
    if (name === './traceArchive')
      return {
        listArchivedObjects: async () => [],
        readArchivedArtifact: async () => null,
        deleteArchivedBundle: remove,
        decryptAndValidateArtifact: () => {
          throw new Error('unexpected decryption');
        },
      };
    throw new Error('unmocked IO dependency: ' + name);
  };
  new Function('exports', 'require', 'module', compiled)(owner.exports, io, owner);
  assert.ok(owner.exports.curateTraceArchives);
  return owner.exports.curateTraceArchives;
}
const auditResult = {
  ok: false,
  missing: ['offline'],
  invalid: [],
  objectCount: 0,
  encryptedObjectCount: 0,
  decryptedObjectCount: 0,
};
export async function runCurationPoolControls(): Promise<void> {
  const failures: string[] = [];
  for (const phase of [
    'classification',
    'deletion',
    'onResult',
    'undefined-error',
    'secondary-error',
  ]) {
    const peer = deferred();
    const trigger = deferred();
    const entered = deferred();
    const claims: string[] = [];
    const deleted: string[] = [];
    const afterRejection: string[] = [];
    const original = phase === 'undefined-error' ? undefined : new Error('original-' + phase);
    let rejected = false;
    let settled = false;
    const audit = async (id: string) => {
      claims.push(id);
      if (id === 'b') {
        entered.resolve();
        await peer.promise;
        if (phase === 'secondary-error') throw new Error('secondary');
      }
      if (
        id === 'a' &&
        (phase === 'classification' || phase === 'undefined-error' || phase === 'secondary-error')
      ) {
        await trigger.promise;
        throw original;
      }
      return auditResult;
    };
    const owner = loadOwner(audit, async (id) => {
      if (id === 'a' && phase === 'deletion') {
        await trigger.promise;
        throw original;
      }
      deleted.push(id);
      if (rejected) afterRejection.push(id);
      return { deletedObjectCount: 1 };
    });
    const operation = owner({
      rootAgentIds: ['a', 'b', 'c', 'd'],
      concurrency: 2,
      deleteRejected: true,
      onResult: (_v, index) => {
        if (index === 0 && phase === 'onResult') throw original;
      },
    });
    const caught = operation.then(
      () => {
        settled = true;
        return { rejected: false, error: null };
      },
      (error: unknown) => {
        settled = true;
        rejected = true;
        return { rejected: true, error };
      }
    );
    await entered.promise;
    trigger.resolve();
    await checkpoint();
    const early = settled;
    const claimsAtFailure = [...claims];
    peer.resolve();
    const outcome = await caught;
    await checkpoint();
    const check = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        failures.push(String(error));
      }
    };
    check(() => assert.equal(early, false, phase + ': caller must not reject before peer joins'));
    check(() => assert.deepEqual(claimsAtFailure, ['a', 'b']));
    check(() =>
      assert.deepEqual(claims, ['a', 'b'], phase + ': no new claims after first failure')
    );
    check(() =>
      assert.deepEqual(afterRejection, [], phase + ': no deletion after caller rejection')
    );
    check(() => assert.equal(outcome.rejected, true));
    check(() =>
      assert.equal(outcome.error, original, phase + ': original error identity retained')
    );
  }
  const gates = [deferred(), deferred()];
  const claims: string[] = [];
  let active = 0;
  let peak = 0;
  const callbacks: number[] = [];
  const owner = loadOwner(
    async (id) => {
      claims.push(id);
      active++;
      peak = Math.max(peak, active);
      if (id === 'a') await gates[0].promise;
      if (id === 'b') await gates[1].promise;
      active--;
      return auditResult;
    },
    async () => ({ deletedObjectCount: 0 })
  );
  const success = owner({
    rootAgentIds: ['a', 'b', 'c', 'd'],
    concurrency: 2,
    onResult: (_v, i) => callbacks.push(i),
  });
  await checkpoint();
  assert.deepEqual(claims, ['a', 'b']);
  gates[1].resolve();
  await checkpoint();
  gates[0].resolve();
  const result = await success;
  assert.equal(peak, 2);
  assert.deepEqual(
    result.map((r) => r.classification.rootAgentId),
    ['a', 'b', 'c', 'd']
  );
  assert.deepEqual(callbacks, [1, 2, 3, 0]);
  assert.deepEqual(await owner({ rootAgentIds: [], concurrency: 2 }), []);
  await assert.rejects(owner({ rootAgentIds: ['a'], concurrency: NaN }), /concurrency must/);
  assert.deepEqual(
    await owner({ rootAgentIds: ['a'], concurrency: 1.9 }).then((r) =>
      r.map((x) => x.classification.rootAgentId)
    ),
    ['a']
  );
  assert.deepEqual(failures, [], failures.join('\n'));
}
