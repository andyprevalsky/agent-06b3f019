import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createTestHarness } from './trace-archive-test-utils';
import { fixture } from './worker-process-test-fixtures';
import {
  canonicalWorkerJSON,
  signWorkerEnvelope,
  workerPlanIdentity,
  workerSHA256,
} from '../../providers/workerProcessDeployment';
import {
  getWorkerProcessRuntimeEnvelope,
  type WorkerProcessRepository,
} from '../../providers/workerProcessRecovery';
import { createWorkerProcessRuntimeRouter } from '../../domains/worker-process-runtime/routes';

const { test, finish } = createTestHarness('private retained worker runtime envelope');
function envelopeFixture(action: 'status' | 'ensure' = 'ensure') {
  const { plan } = fixture();
  const key = 'LOCAL-CAPSULE-FIXTURE-NOT-PRODUCTION';
  const version = 'owned-version';
  const bootId = randomUUID();
  const id = plan.hosts[0].id;
  const expected = signWorkerEnvelope(
    plan,
    { id, version, state: 'started', config: null },
    { machineId: id, machineVersion: version, bootId },
    action,
    key
  );
  const query = {
    action,
    app: plan.app,
    machineId: id,
    machineVersion: version,
    bootId,
    planIdentity: workerPlanIdentity(plan),
    envelopeSHA256: workerSHA256(canonicalWorkerJSON(expected)),
  };
  let reads = 0;
  const repository: WorkerProcessRepository = {
    async read() {
      reads++;
      return { version: 1, identity: workerPlanIdentity(plan), plan };
    },
    async record() {
      throw new Error('Source read must never mutate desired state');
    },
  };
  const environment = {
    NODE_ENV: 'production',
    RENDER: 'true',
    RENDER_SERVICE_ID: plan.controlPlane.serviceId,
    RENDER_INSTANCE_ID: 'LOCAL-FIXTURE-INSTANCE',
    RENDER_GIT_COMMIT: plan.artifact.sourceCommit,
    DATABASE_URL: 'postgresql://fixture:fixture@qualified.remote.test/production',
    BACKEND_API_KEY: key,
  };
  return { plan, key, query, expected, repository, environment, reads: () => reads };
}
async function main() {
  await test('exact retained ensure and compact status return unchanged authenticated envelopes', async () => {
    for (const action of ['ensure', 'status'] as const) {
      const f = envelopeFixture(action);
      const result = await getWorkerProcessRuntimeEnvelope(f.query, f);
      assert.deepEqual(result, f.expected);
      assert.equal(result.bundleBase64, action === 'status' ? null : f.plan.artifact.bundleBase64);
      assert.equal(f.reads(), 1);
      assert(!JSON.stringify(result).includes(f.key));
    }
  });
  await test('foreign intent, host, boot, action or request hash cannot retrieve source', async () => {
    const f = envelopeFixture();
    for (const change of [
      { app: 'foreign-app' },
      { machineId: 'ffffffffffffff' },
      { machineVersion: 'other-version' },
      { bootId: randomUUID() },
      { planIdentity: 'd'.repeat(64) },
      { envelopeSHA256: 'e'.repeat(64) },
      { action: 'stop' },
      { action: ['ensure'] },
      { extra: 'unexpected' },
    ]) {
      await assert.rejects(getWorkerProcessRuntimeEnvelope({ ...f.query, ...change }, f));
    }
    await assert.rejects(
      getWorkerProcessRuntimeEnvelope(f.query, {
        ...f,
        repository: { ...f.repository, read: async () => undefined },
      })
    );
  });
  await test('a copied local or different-service record cannot authorize private source publication', async () => {
    for (const change of [
      { NODE_ENV: 'test' },
      { RENDER: 'false' },
      { RENDER_SERVICE_ID: 'srv-other' },
      { DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/production' },
      { RENDER_GIT_COMMIT: 'd'.repeat(40) },
    ]) {
      const f = envelopeFixture();
      await assert.rejects(
        getWorkerProcessRuntimeEnvelope(f.query, {
          ...f,
          environment: { ...f.environment, ...change },
        })
      );
    }
    const f = envelopeFixture();
    await assert.rejects(
      getWorkerProcessRuntimeEnvelope(f.query, {
        ...f,
        environment: { ...f.environment, NODE_ENV: 'test' },
      })
    );
    assert.equal(f.reads(), 0, 'non-production requests must deny before reading copied source');
  });
  await test('mounted HTTP route denies unauthenticated callers and marks private JSON no-store', async () => {
    const original = process.env.BACKEND_API_KEY;
    const f = envelopeFixture();
    process.env.BACKEND_API_KEY = f.key;
    let issued = 0;
    const app = express();
    app.use(
      '/api/worker-process-runtime',
      createWorkerProcessRuntimeRouter(async (query) => {
        issued++;
        return getWorkerProcessRuntimeEnvelope(query, f);
      })
    );
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/worker-process-runtime`;
      const query = new URLSearchParams(f.query).toString();
      const unauthorized = await fetch(`${origin}?${query}`);
      assert.equal(unauthorized.status, 401);
      assert.equal(issued, 0);
      const valid = await fetch(`${origin}?${query}`, { headers: { 'X-API-Key': f.key } });
      assert.equal(valid.status, 200);
      assert.equal(valid.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await valid.json(), f.expected);
      const foreign = new URLSearchParams({ ...f.query, envelopeSHA256: 'f'.repeat(64) });
      const rejected = await fetch(`${origin}?${foreign}`, { headers: { 'X-API-Key': f.key } });
      assert.equal(rejected.status, 409);
      assert(!JSON.stringify(await rejected.json()).includes(f.plan.artifact.bundleBase64));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      );
      if (original === undefined) delete process.env.BACKEND_API_KEY;
      else process.env.BACKEND_API_KEY = original;
    }
  });
  finish();
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
