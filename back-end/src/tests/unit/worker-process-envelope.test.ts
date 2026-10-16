import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createTestHarness, withEnv } from './trace-archive-test-utils';
import { prisma } from '../../providers/database';
import { fixture, config } from './worker-process-test-fixtures';
import {
  canonicalWorkerJSON,
  validateWorkerProcessPlan,
  reconcileWorkerProcesses,
  signWorkerEnvelope,
  workerPlanIdentity,
  workerSHA256,
} from '../../providers/workerProcessDeployment';
import {
  getWorkerProcessRuntimeEnvelope,
  recoverConfiguredWorkerProcesses,
  requireBackendWorkerRecovery,
  WORKER_PROCESS_DESIRED_KEY,
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
type RecoveryRow = {
  operationKey: string;
  operationType: string;
  status: string;
  externalId?: string;
  updatedAt: Date;
  request?: unknown;
  response?: unknown;
};
async function withRecoveryRows(
  plan: ReturnType<typeof fixture>['plan'],
  run: (rows: Map<string, RecoveryRow>) => Promise<void>
) {
  const rows = new Map<string, RecoveryRow>([
    [
      WORKER_PROCESS_DESIRED_KEY,
      {
        operationKey: WORKER_PROCESS_DESIRED_KEY,
        operationType: 'EXISTING_WORKER_PROCESS_DEPLOYMENT',
        status: 'ACTIVE',
        updatedAt: new Date(),
        request: { version: 1, identity: workerPlanIdentity(plan), plan },
      },
    ],
  ]);
  const delegate = {
    async findUnique({ where }: { where: { operationKey: string } }) {
      return structuredClone(rows.get(where.operationKey) ?? null);
    },
    async upsert({
      where,
      create,
      update,
    }: {
      where: { operationKey: string };
      create: RecoveryRow;
      update: Partial<RecoveryRow>;
    }) {
      const next = rows.has(where.operationKey)
        ? { ...rows.get(where.operationKey)!, ...update, updatedAt: update.updatedAt ?? new Date() }
        : { ...create, updatedAt: create.updatedAt ?? new Date() };
      rows.set(where.operationKey, structuredClone(next));
      return next;
    },
    async update({ where, data }: { where: { operationKey: string }; data: Partial<RecoveryRow> }) {
      const next = {
        ...rows.get(where.operationKey)!,
        ...data,
        updatedAt: data.updatedAt ?? new Date(),
      };
      rows.set(where.operationKey, structuredClone(next));
      return next;
    },
    async updateMany({ where, data }: { where: Partial<RecoveryRow>; data: Partial<RecoveryRow> }) {
      const row = rows.get(where.operationKey!);
      if (
        !row ||
        Object.entries(where).some(([key, value]) => {
          const actual = row[key as keyof RecoveryRow];
          if (value && typeof value === 'object' && 'gt' in value) {
            return !(
              value.gt instanceof Date &&
              actual instanceof Date &&
              actual.getTime() > value.gt.getTime()
            );
          }
          return actual !== value;
        })
      )
        return { count: 0 };
      rows.set(row.operationKey, { ...row, ...data, updatedAt: data.updatedAt ?? new Date() });
      return { count: 1 };
    },
  };
  const originalTransaction = prisma.$transaction,
    originalDelegate = prisma.toolSideEffect;
  prisma.$transaction = (async (fn: (tx: unknown) => unknown) =>
    fn({
      $executeRaw: async () => 1,
      $queryRaw: async (query: TemplateStringsArray) => {
        assert.equal(query.join(''), 'SELECT clock_timestamp() AS now');
        return [{ now: new Date() }];
      },
      toolSideEffect: delegate,
    })) as never;
  Object.defineProperty(prisma, 'toolSideEffect', { configurable: true, value: delegate });
  try {
    await run(rows);
  } finally {
    prisma.$transaction = originalTransaction;
    Object.defineProperty(prisma, 'toolSideEffect', {
      configurable: true,
      value: originalDelegate,
    });
  }
}
async function main() {
  await test('signed broker origin reaches only candidate environment and rejects invalid handoffs before effects', () => {
    const f = fixture();
    const host = { id: f.plan.hosts[0].id, version: 'instance', state: 'started', config };
    const facts = { machineId: host.id, machineVersion: host.version, bootId: randomUUID() };
    const identity = workerPlanIdentity(f.plan);
    for (const value of [
      undefined,
      null,
      '',
      'https://foreign.example',
      'https://navi-j9a9.onrender.com/',
    ]) {
      const bad = structuredClone(f.plan);
      Object.assign(bad, { peopleCredentialBrokerOrigin: value });
      assert.notEqual(workerPlanIdentity(bad), identity);
      assert.throws(() => validateWorkerProcessPlan(bad), /broker origin/);
      assert.throws(
        () => signWorkerEnvelope(bad, host, facts, 'ensure', 'fixture-key'),
        /broker origin/
      );
    }
    for (const action of ['ensure', 'status'] as const) {
      const envelope = signWorkerEnvelope(f.plan, host, facts, action, 'fixture-key');
      const output = execFileSync(
        'python3',
        [
          '-I',
          '-B',
          '-c',
          `
import copy,hmac,hashlib,json,os,runpy,sys
from pathlib import Path
from unittest.mock import patch
m=runpy.run_path(sys.argv[1]); request=json.load(sys.stdin); before=dict(os.environ)
m['authenticate'](request,'fixture-key')
for inherited in ({}, {'PEOPLE_CREDENTIAL_BROKER_URL':'https://foreign.example','TEMPORAL_TASK_QUEUE':'old'}):
 original=dict(inherited)
 candidate=m['worker_environment'](request,Path('/owned/runtime'),inherited)
 assert candidate['PEOPLE_CREDENTIAL_BROKER_URL']=='https://navi-j9a9.onrender.com'
 assert inherited==original and os.environ==before
for value in (None, '', 'https://foreign.example', 'https://navi-j9a9.onrender.com/', {'url':'https://navi-j9a9.onrender.com'}):
 bad=copy.deepcopy(request); bad['peopleCredentialBrokerOrigin']=value
 for signed in (False,True):
  if signed: bad['signature']=hmac.new(b'fixture-key',m['canonical']({k:v for k,v in bad.items() if k!='signature'}),hashlib.sha256).hexdigest()
  try: m['authenticate'](bad,'fixture-key')
  except ValueError as error: assert str(error) in ('signature mismatch','people credential broker origin')
  else: raise AssertionError('invalid broker authenticated')
  with patch.dict(os.environ,{'BACKEND_API_KEY':'fixture-key'}), patch.dict(m['dispatch'].__globals__,prepare_slot=lambda *_: (_ for _ in ()).throw(AssertionError('staged before auth'))):
   try: m['dispatch'](bad)
   except ValueError: pass
   else: raise AssertionError('invalid broker admitted')
missing=copy.deepcopy(request); del missing['peopleCredentialBrokerOrigin']
try: m['authenticate'](missing,'fixture-key')
except ValueError: pass
else: raise AssertionError('missing broker accepted')
if request['action']=='status':
 compact=copy.deepcopy(request); del compact['bundleBase64']
 compact['signature']=hmac.new(b'fixture-key',m['canonical']({k:v for k,v in compact.items() if k!='signature'}),hashlib.sha256).hexdigest()
 m['authenticate'](compact,'fixture-key')
assert m['intent_digest'](request)!=m['intent_digest']({**request,'peopleCredentialBrokerOrigin':'https://foreign.example'})
print('authenticated isolated candidate broker')
`,
          resolve(__dirname, '../../../../scripts/production_worker_process.py'),
        ],
        {
          input: JSON.stringify(envelope),
          encoding: 'utf8',
          env: { PATH: process.env.PATH },
        }
      );
      assert.match(output, /authenticated isolated candidate broker/);
    }
  });

  await test('exact retained ensure and compact status return unchanged authenticated envelopes', async () => {
    for (const action of ['ensure', 'status'] as const) {
      const f = envelopeFixture(action);
      const result = await getWorkerProcessRuntimeEnvelope(f.query, f);
      assert.deepEqual(result, f.expected);
      assert.equal(result.peopleCredentialBrokerOrigin, f.plan.peopleCredentialBrokerOrigin);
      assert.equal(result.bundleBase64, action === 'status' ? null : f.plan.artifact.bundleBase64);
      assert.equal(f.reads(), 1);
      assert(!JSON.stringify(result).includes(f.key));
    }
  });
  await test('later backend revision serves the unchanged retained worker artifact', async () => {
    for (const action of ['ensure', 'status'] as const) {
      const f = envelopeFixture(action);
      const artifact = structuredClone(f.plan.artifact);
      const result = await getWorkerProcessRuntimeEnvelope(f.query, {
        ...f,
        environment: { ...f.environment, RENDER_GIT_COMMIT: 'd'.repeat(40) },
      });
      assert.deepEqual(result, f.expected);
      assert.deepEqual(f.plan.artifact, artifact);
      assert.equal(result.sourceCommit, artifact.sourceCommit);
      assert.equal(f.reads(), 1);
    }
  });
  await test('configured recovery publishes actual later backend provenance while retaining exact worker source', async () => {
    const f = fixture(),
      service = envelopeFixture();
    const before = structuredClone(f.plan.artifact);
    await withRecoveryRows(f.plan, async (rows) => {
      await withEnv({ ...service.environment, RENDER_GIT_COMMIT: 'd'.repeat(40) }, async () => {
        const observed = await recoverConfiguredWorkerProcesses({ transport: f.transport });
        assert.equal(observed.length, 8);
        assert(
          observed.every(
            (row) => row.phase === 'STANDBY' && row.receipt?.sourceCommit === before.sourceCommit
          )
        );
        await requireBackendWorkerRecovery(f.plan, 'STANDBY');
        const persisted = rows.get(WORKER_PROCESS_DESIRED_KEY)!;
        const response = persisted.response as {
          backendRecovery: { backendSource: string; hosts: typeof observed };
        };
        assert.equal(response.backendRecovery.backendSource, 'd'.repeat(40));
        assert.deepEqual(f.plan.artifact, before);
        response.backendRecovery.backendSource = 'invalid';
        await assert.rejects(requireBackendWorkerRecovery(f.plan), /backend recovery owner/);
        response.backendRecovery.backendSource = 'd'.repeat(40);
        response.backendRecovery.hosts[0].receipt!.sourceCommit = 'e'.repeat(40);
        await assert.rejects(
          requireBackendWorkerRecovery(f.plan),
          /Runtime receipt belongs to another source or attempt/
        );
      })();
      assert(
        f.calls.every((call) => call.action === 'status'),
        'healthy recovery must not fabricate process absence'
      );
    });
  });
  await test('backend recovery proof accepts valid independent source but rejects invalid and foreign worker receipts', async () => {
    const f = fixture();
    const observed = await reconcileWorkerProcesses(
      f.plan,
      f.transport,
      'fixture-key',
      async () => {}
    );
    await withRecoveryRows(f.plan, async (rows) => {
      const row = rows.get(WORKER_PROCESS_DESIRED_KEY)!;
      const proof = {
        identity: workerPlanIdentity(f.plan),
        instanceId: 'OTHER-BACKEND-INSTANCE',
        serviceId: f.plan.controlPlane.serviceId,
        backendSource: 'd'.repeat(40),
        observedAt: new Date().toISOString(),
        hosts: observed,
      };
      row.response = { backendRecovery: proof };
      await requireBackendWorkerRecovery(f.plan, 'STANDBY');
      for (const invalid of ['', 'g'.repeat(40), 'd'.repeat(39)]) {
        proof.backendSource = invalid;
        await assert.rejects(requireBackendWorkerRecovery(f.plan), /backend recovery owner/);
      }
      proof.backendSource = 'd'.repeat(40);
      proof.hosts[0].receipt!.buildId = 'e'.repeat(40);
      await assert.rejects(
        requireBackendWorkerRecovery(f.plan),
        /Runtime receipt belongs to another source or attempt/
      );
    });
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
  await test('changed broker origin cannot reuse retained plan identity or private envelope digest', async () => {
    const f = envelopeFixture();
    const changed = structuredClone(f.plan);
    Object.assign(changed, { peopleCredentialBrokerOrigin: 'https://foreign.example' });
    assert.notEqual(workerPlanIdentity(changed), f.query.planIdentity);
    await assert.rejects(
      getWorkerProcessRuntimeEnvelope(f.query, {
        ...f,
        repository: {
          ...f.repository,
          read: async () => ({ version: 1, identity: f.query.planIdentity, plan: changed }),
        },
      })
    );
  });
  await test('a copied local or different-service record cannot authorize private source publication', async () => {
    for (const change of [
      { NODE_ENV: 'test' },
      { RENDER: 'false' },
      { RENDER_SERVICE_ID: 'srv-other' },
      { DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/production' },
      { RENDER_GIT_COMMIT: 'invalid-backend-revision' },
      { RENDER_GIT_COMMIT: '' },
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
