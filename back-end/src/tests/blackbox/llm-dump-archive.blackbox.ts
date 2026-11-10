import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';

// The isolated fixture needs the canonical CommonJS cache API to install its
// database authority doubles before loading the actual production modules.
const fixtureRequire = createRequire(__filename);
process.umask(0o077);
const root = path.resolve(__dirname, '../../../..'),
  providers = root + '/back-end/src/providers',
  candidate = providers;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-node-archive-'));
process.env.NODE_ENV = 'development';
process.env.FLY_APP_NAME = '';
process.env.TRACE_ARCHIVE_ENABLED = 'true';
process.env.TRACE_ARCHIVE_BACKEND = 'local';
process.env.TRACE_ARCHIVE_LOCAL_DIR = temp;
process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString('base64');
let networkCalls = 0;
const deny = () => {
  networkCalls++;
  throw Error('Network forbidden in archive fixture');
};
global.fetch = deny;
http.request = deny;
https.request = deny;
const agents = new Map(),
  gates = new Map(),
  logs = [];
const db = {
  prisma: {
    agent: {
      findUnique: async ({ where }) => {
        if (gates.has(where.id)) await gates.get(where.id);
        return agents.get(where.id) || null;
      },
      findFirst: async ({ where }) => {
        const row = agents.get(where.id);
        return row && row.userId === where.userId ? row : null;
      },
    },
  },
};
function inject(p, exports) {
  const key = fixtureRequire.resolve(p);
  fixtureRequire.cache[key] = { id: key, filename: key, loaded: true, exports };
}
inject(providers + '/database.ts', db);
inject(providers + '/logger.ts', {
  createLogger: () => ({
    info: (...v) => logs.push(v),
    warn: (...v) => logs.push(v),
    error: (...v) => logs.push(v),
    debug: () => {},
  }),
});
const actualRandomUUID = crypto.randomUUID;
let descendingIds = false;
let descendingCounter = 1000;
crypto.randomUUID = () =>
  descendingIds
    ? `${(descendingCounter--).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
    : actualRandomUUID();
const RealMap = global.Map;
let capturedHandleMap = null;
let capturingMap = false;
global.Map = class extends RealMap {
  constructor(...args) {
    super(...args);
    if (capturedHandleMap === null && !capturingMap) {
      capturingMap = true;
      try {
        const caller = String(new Error().stack).split('\n')[2] || '';
        if (caller.includes('/providers/llmDump.ts:')) capturedHandleMap = new WeakRef(this);
      } finally {
        capturingMap = false;
      }
    }
  }
};
const archive = fixtureRequire(providers + '/traceArchive.ts'),
  writer = fixtureRequire(providers + '/traceArchiveLifecycle.ts');
let mode = 'normal',
  baseGate = null;
const writes = [];
inject(candidate + '/traceArchiveLifecycle.ts', {
  storeWorkerArtifact: async (input) => {
    writes.push(input.path);
    if (mode === 'fail') throw Error('private storage failure');
    const out = await writer.storeWorkerArtifact(input);
    if (baseGate && input.path.startsWith('llm/')) await baseGate;
    return out;
  },
});
const h = fixtureRequire(candidate + '/llmDump.ts'),
  materializer = fixtureRequire(providers + '/archiveLlmMaterialization.ts');
global.Map = RealMap;
const moduleHandleMap = capturedHandleMap?.deref();
assert.ok(moduleHandleMap, 'capture only the actual module handle Map without a production export');
const user = crypto.randomUUID(),
  canary = 'PRIVATE_CONTEXT_CANARY_NOT_A_CREDENTIAL';
const payload = (id) => ({
  call_site: 'chat_generator',
  agent_id: id,
  model: 'fixture-model',
  message_count: 1,
  messages: [{ role: 'user', content: canary }],
  tools: [{ type: 'function', function: { name: 'fixture' } }],
  response_format: { type: 'json_object' },
  config: { temperature: 0 },
});
function agent(id, parent = null, owner = user) {
  agents.set(id, { id, parentAgentId: parent, userId: owner });
}
function gate() {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
}
(async () => {
  let cases = 0;
  const disabled = crypto.randomUUID();
  agent(disabled);
  process.env.TRACE_ARCHIVE_ENABLED = 'false';
  assert.equal(h.dumpLlmContext(payload(disabled)), null);
  await h.drainLlmDumpArchives(disabled, [disabled]);
  assert.equal(writes.length, 0);
  process.env.TRACE_ARCHIVE_ENABLED = 'true';
  cases++;
  const id = crypto.randomUUID();
  agent(id);
  const binding = gate(),
    ack = gate();
  gates.set(id, binding.promise);
  baseGate = ack.promise;
  const handle = h.dumpLlmContext(payload(id));
  assert.ok(handle.startsWith('private-llm:'));
  h.updateLlmDump(handle, {
    model: 'actual-model',
    config: { finish_reason: 'stop' },
    extra: { output: 'original private result' },
  });
  let drained = false;
  const draining = h.drainLlmDumpArchives(id, [id]).then(() => (drained = true));
  await new Promise(setImmediate);
  assert.equal(drained, false);
  assert.equal(writes.length, 0);
  binding.release();
  gates.delete(id);
  while (writes.length === 0) await new Promise(setImmediate);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].startsWith('llm/'));
  await new Promise(setImmediate);
  assert.equal(drained, false);
  ack.release();
  await draining;
  baseGate = null;
  assert.equal(writes.length, 2);
  assert.ok(writes[1].startsWith('llm-updates/'));
  const recovered = await materializer.materializeArchiveLlmDumps(id, path.join(temp, 'recovery'), {
    list: archive.listArchivedObjectsStrict,
    read: (r, p) => archive.readArchivedArtifactStrict({ rootAgentId: r, objectPath: p }),
  });
  assert.equal(recovered.baseCallCount, 1);
  assert.equal(recovered.updateCount, 1);
  const actual = JSON.parse(fs.readFileSync(recovered.latest.path, 'utf8'));
  assert.equal(actual.root_agent_id, id);
  assert.equal(actual.agent_id, id);
  assert.equal(actual.messages[0].content, canary);
  assert.equal(actual.extra.output, 'original private result');
  assert.equal(actual.config.temperature, 0);
  assert.equal(actual.config.finish_reason, 'stop');
  assert.equal(actual.tools[0].function.name, 'fixture');
  assert.deepEqual(actual.response_format, { type: 'json_object' });
  assert.equal(fs.existsSync(path.resolve(candidate, '../../..', '.llm-dumps', id)), false);
  for (const p of archive.listArchivedObjectsStrict
    ? await archive.listArchivedObjectsStrict(id)
    : []) {
    const stored = await archive.readArchivedArtifactStrict({
      rootAgentId: id,
      objectPath: p.path,
    });
    assert.equal(stored.ciphertext.includes(Buffer.from(canary)), false);
  }
  cases++;
  const failed = crypto.randomUUID();
  agent(failed);
  mode = 'fail';
  const before = writes.length,
    broken = h.dumpLlmContext(payload(failed));
  h.updateLlmDump(broken, { extra: { output: 'must not publish' } });
  await assert.rejects(
    h.drainLlmDumpArchives(failed, [failed]),
    /Required private LLM archive failed/
  );
  assert.equal(writes.length, before + 1);
  mode = 'normal';
  cases++;
  const foreign = crypto.randomUUID(),
    foreignParent = crypto.randomUUID();
  agent(foreign, foreignParent);
  agent(foreignParent, null, crypto.randomUUID());
  const beforeForeign = writes.length;
  h.dumpLlmContext(payload(foreign));
  await assert.rejects(h.drainLlmDumpArchives(foreign, [foreign]), /Required private/);
  assert.equal(writes.length, beforeForeign);
  cases++;
  const own = crypto.randomUUID();
  agent(own);
  h.dumpLlmContext(payload(own));
  await assert.rejects(h.drainLlmDumpArchives(crypto.randomUUID(), [own]), /Required private/);
  await h.drainLlmDumpArchives(own, [own]);
  cases++;
  const slow = crypto.randomUUID(),
    fast = crypto.randomUUID(),
    slowGate = gate();
  agent(slow);
  agent(fast);
  gates.set(slow, slowGate.promise);
  h.dumpLlmContext(payload(slow));
  h.dumpLlmContext(payload(fast));
  await h.drainLlmDumpArchives(fast, [fast]);
  slowGate.release();
  gates.delete(slow);
  await h.drainLlmDumpArchives(slow, [slow]);
  cases++;
  const prior = writes.length;
  h.updateLlmDump('private-llm:caller-forged', { messages: [canary] });
  assert.equal(writes.length, prior);
  assert.equal(JSON.stringify(logs).includes(canary), false);
  assert.equal(networkCalls, 0);
  cases++;
  delete process.env.FLY_APP_NAME;
  process.env.TRACE_ARCHIVE_ENABLED = 'false';
  const dev = 'offline-node-dev-' + process.pid,
    local = h.dumpLlmContext(payload(dev));
  assert.ok(local);
  h.updateLlmDump(local, { config: { effort: 'minimal' } });
  assert.equal(JSON.parse(fs.readFileSync(local)).config.effort, 'minimal');
  fs.unlinkSync(local);
  fs.rmdirSync(path.dirname(local));
  cases++;
  process.env.FLY_APP_NAME = '';
  process.env.TRACE_ARCHIVE_ENABLED = 'true';
  const manifest = fixtureRequire(providers + '/traceArchiveManifest.ts');
  let fences = 0;
  inject(providers + '/traceArchiveFixture.ts', {
    collectFixture: async (rootId) => ({
      rows: {
        Agent: [{ id: rootId, status: 'COMPLETED', goal: 'private fixture' }],
      },
      agent_ids: [rootId],
      user_id: user,
      base_image: 'fixture',
      captured_at: new Date().toISOString(),
    }),
  });
  inject(providers + '/traceArchiveManifest.ts', {
    ...manifest,
    withArchiveManifestLock: async (_root, operation) => operation(),
    writeFinalizationMarker: async (rootId) => {
      fences++;
      return manifest.writeFinalizationMarker(rootId);
    },
  });
  inject(providers + '/traceArchiveSearchIndex.ts', {
    indexArchivedTrace: async () => {},
    indexLateArchivedLlmArtifact: async () => {},
  });
  inject(providers + '/plannerMemoryEmbedding.ts', {
    scheduleFinalizeEmbedding: () => {},
  });
  inject(providers + '/plannerMemoryStore.ts', {
    upsertPlannerMemoryFromRun: async () => {},
  });
  delete fixtureRequire.cache[fixtureRequire.resolve(candidate + '/traceArchiveLifecycle.ts')];
  const lifecycle = fixtureRequire(candidate + '/traceArchiveLifecycle.ts');
  const finalRoot = crypto.randomUUID(),
    finalGate = gate();
  agent(finalRoot);
  gates.set(finalRoot, finalGate.promise);
  const finalHandle = h.dumpLlmContext(payload(finalRoot));
  h.updateLlmDump(finalHandle, {
    extra: { output: 'joined before finalization' },
  });
  let finalized = false;
  const finalization = lifecycle.finalizeAgent({ rootAgentId: finalRoot }).then((v) => {
    finalized = true;
    return v;
  });
  await new Promise(setImmediate);
  assert.equal(fences, 0);
  assert.equal(finalized, false);
  finalGate.release();
  gates.delete(finalRoot);
  await finalization;
  assert.equal(fences, 1);
  const finalListing = await archive.listArchivedObjectsStrict(finalRoot);
  assert.ok(finalListing.some((v) => v.path.startsWith('llm/')));
  assert.ok(finalListing.some((v) => v.path.startsWith('llm-updates/')));
  assert.ok(finalListing.some((v) => v.path === 'manifest.json.gz.enc'));
  cases++;
  const failedFinalRoot = crypto.randomUUID();
  agent(failedFinalRoot);
  const priorKey = process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64;
  process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = 'invalid';
  h.dumpLlmContext(payload(failedFinalRoot));
  await assert.rejects(
    lifecycle.finalizeAgent({ rootAgentId: failedFinalRoot }),
    /Required private/
  );
  assert.equal(fences, 1);
  process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = priorKey;
  cases++;
  assert.equal(networkCalls, 0);
  assert.equal(JSON.stringify(logs).includes(canary), false);
  const circularRoot = crypto.randomUUID();
  agent(circularRoot);
  const circular = payload(circularRoot);
  circular.extra = {};
  circular.extra.self = circular.extra;
  assert.ok(h.dumpLlmContext(circular));
  await assert.rejects(h.drainLlmDumpArchives(circularRoot, [circularRoot]), /Required private/);
  cases++;
  const circularUpdateRoot = crypto.randomUUID();
  agent(circularUpdateRoot);
  const circularHandle = h.dumpLlmContext(payload(circularUpdateRoot));
  const circularPatch = {};
  circularPatch.self = circularPatch;
  assert.doesNotThrow(() => h.updateLlmDump(circularHandle, circularPatch));
  await assert.rejects(
    h.drainLlmDumpArchives(circularUpdateRoot, [circularUpdateRoot]),
    /Required private/
  );
  cases++;
  const sameMillisRoot = crypto.randomUUID();
  agent(sameMillisRoot);
  const originalNow = Date.now;
  Date.now = () => 1900000000000;
  descendingIds = true;
  try {
    const sameMillisHandle = h.dumpLlmContext(payload(sameMillisRoot));
    h.updateLlmDump(sameMillisHandle, { extra: { output: 'FIRST' } });
    h.updateLlmDump(sameMillisHandle, { extra: { output: 'SECOND' } });
    await h.drainLlmDumpArchives(sameMillisRoot, [sameMillisRoot]);
    const ordered = await materializer.materializeArchiveLlmDumps(
      sameMillisRoot,
      path.join(temp, 'same-millis'),
      {
        list: archive.listArchivedObjectsStrict,
        read: (root, objectPath) =>
          archive.readArchivedArtifactStrict({ rootAgentId: root, objectPath }),
      }
    );
    assert.equal(JSON.parse(fs.readFileSync(ordered.latest.path, 'utf8')).extra.output, 'SECOND');
    assert.equal(ordered.updateCount, 2);
  } finally {
    Date.now = originalNow;
    descendingIds = false;
  }
  cases++;
  const regressedRoot = crypto.randomUUID();
  agent(regressedRoot);
  let actualClock = 1900000000000;
  Date.now = () => actualClock;
  try {
    const regressedHandle = h.dumpLlmContext(payload(regressedRoot));
    const baseDeadline = performance.now() + 20_000;
    while (
      !(await archive.listArchivedObjectsStrict(regressedRoot)).some((item) =>
        item.path.startsWith('llm/')
      )
    ) {
      assert.ok(
        performance.now() < baseDeadline,
        'original base must be stored before testing clock regression'
      );
      await new Promise(setImmediate);
    }
    actualClock--;
    h.updateLlmDump(regressedHandle, { extra: { output: 'clock regressed' } });
    await assert.rejects(
      h.drainLlmDumpArchives(regressedRoot, [regressedRoot]),
      /Required private/
    );
    const stored = await archive.listArchivedObjectsStrict(regressedRoot);
    assert.equal(stored.filter((item) => item.path.startsWith('llm-updates/')).length, 0);
  } finally {
    Date.now = originalNow;
  }
  cases++;
  assert.equal(networkCalls, 0);
  assert.equal(JSON.stringify(logs).includes(canary), false);
  const indexedRoot = crypto.randomUUID(),
    indexedForeign = crypto.randomUUID(),
    indexedGate = gate();
  agent(indexedRoot);
  agent(indexedForeign);
  gates.set(indexedForeign, indexedGate.promise);
  h.dumpLlmContext(payload(indexedForeign));
  h.dumpLlmContext(payload(indexedRoot));
  const ordinaryValues = moduleHandleMap.values;
  moduleHandleMap.values = () => {
    throw new Error('Global handle-map scan forbidden');
  };
  try {
    await h.drainLlmDumpArchives(indexedRoot, [indexedRoot]);
  } finally {
    moduleHandleMap.values = ordinaryValues;
    indexedGate.release();
    gates.delete(indexedForeign);
  }
  await h.drainLlmDumpArchives(indexedForeign, [indexedForeign]);
  cases++;
  console.log(
    JSON.stringify({
      passed: cases,
      networkCalls,
      privateProtocol: 'real encryptArtifact+storeWorkerArtifact+strict materializer',
      trackedSourceWrites: 0,
    })
  );
})()
  .catch((e) => {
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));
