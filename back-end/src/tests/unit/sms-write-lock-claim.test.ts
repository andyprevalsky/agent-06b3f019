/** Verify claim retries before any send and deduplication after an uncertain or accepted send. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, type ToolSideEffect } from '@prisma/client';
import { prisma } from '../../providers/database';
import { dispatchWriteLockOnce } from '../../domains/send-sms/service.writeLockOnce';

type Failure =
  | 'phone'
  | 'attachment-body'
  | 'upload'
  | 'eligibility'
  | 'ambiguous'
  | 'accepted-persist'
  | 'accepted-mms-persist'
  | 'accepted';
const records = new Map<string, ToolSideEffect>();
const originals = {
  create: prisma.toolSideEffect.create,
  findUniqueOrThrow: prisma.toolSideEffect.findUniqueOrThrow,
  updateMany: prisma.toolSideEffect.updateMany,
  update: prisma.toolSideEffect.update,
  findUser: prisma.user.findUnique,
  findAgent: prisma.agent.findUnique,
  executeRaw: prisma.$executeRaw,
  fetch: globalThis.fetch,
};
const testEnv = {
  ALLOW_LIVE_MESSAGING: '1',
  TRACE_ARCHIVE_ENABLED: '0',
  SURGE_API_KEY: 'write-lock-unit-key',
  SURGE_ACCOUNT_ID: 'write-lock-unit-account',
  SUPABASE_URL: 'https://write-lock-storage.fixture.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'write-lock-unit-storage-key',
  BENCHMARK_ISOLATED_RUN: undefined,
  BENCHMARK_MODE: undefined,
  IS_PULL_REQUEST: 'false',
};
const oldEnv = Object.fromEntries(Object.keys(testEnv).map((key) => [key, process.env[key]]));
let failure: Failure = 'phone';
let repaired = false;
let providerSends = 0;
let phoneLookups = 0;
let attachmentReads = 0;
let uploads = 0;

function getRecord(key: string): ToolSideEffect {
  const record = records.get(key);
  assert(record, `missing claim ${key}`);
  return record;
}

prisma.toolSideEffect.create = (async ({
  data,
}: {
  data: { operationKey: string; operationType: string };
}) => {
  if (records.has(data.operationKey)) {
    throw new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'unit',
    });
  }
  const record: ToolSideEffect = {
    id: randomUUID(),
    operationKey: data.operationKey,
    operationType: data.operationType,
    status: 'STARTED',
    externalId: null,
    request: null,
    response: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  records.set(data.operationKey, record);
  return { ...record };
}) as typeof prisma.toolSideEffect.create;
prisma.toolSideEffect.findUniqueOrThrow = (async ({
  where,
}: {
  where: { operationKey: string };
}) => ({
  ...getRecord(where.operationKey),
})) as typeof prisma.toolSideEffect.findUniqueOrThrow;
prisma.toolSideEffect.updateMany = (async ({
  where,
}: {
  where: { operationKey: string; status: string };
}) => {
  const record = getRecord(where.operationKey);
  if (record.status !== where.status) return { count: 0 };
  record.status = 'STARTED';
  return { count: 1 };
}) as typeof prisma.toolSideEffect.updateMany;
prisma.toolSideEffect.update = (async ({
  where,
  data,
}: {
  where: { operationKey: string };
  data: { status: string; error?: string; externalId?: string };
}) => {
  if (
    data.status === 'SUCCEEDED' &&
    ['accepted-persist', 'accepted-mms-persist'].includes(failure) &&
    !repaired
  ) {
    throw new Error('fixture claim persistence failed after accepted send');
  }
  const record = getRecord(where.operationKey);
  Object.assign(record, data);
  return { ...record };
}) as typeof prisma.toolSideEffect.update;
prisma.user.findUnique = (async () => {
  phoneLookups++;
  if (failure === 'phone' && !repaired) throw new Error('fixture phone lookup failed');
  return { phone: '+15550000123' };
}) as typeof prisma.user.findUnique;
prisma.agent.findUnique = (async () => {
  if (failure === 'eligibility' && !repaired) {
    throw new Error('fixture MMS eligibility lookup failed');
  }
  return { isBenchmark: false };
}) as typeof prisma.agent.findUnique;
prisma.$executeRaw = (async () => 1) as typeof prisma.$executeRaw;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('https://write-lock-image.fixture.invalid/')) {
    attachmentReads++;
    const response = new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { 'content-type': 'image/png' },
    });
    if (failure === 'attachment-body' && !repaired) {
      response.arrayBuffer = async () => {
        throw new Error('fixture attachment response body failed');
      };
    }
    return response;
  }
  if (url.startsWith('https://write-lock-storage.fixture.invalid/')) {
    if (['accepted-mms-persist', 'eligibility'].includes(failure)) {
      if (url.includes('/object/sign/')) {
        return new Response(
          JSON.stringify({
            signedURL: '/object/sign/attachments/fixture.png?token=unit',
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      uploads++;
      return new Response(JSON.stringify({ Key: 'attachments/fixture.png', Id: 'unit-object' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    uploads++;
    return new Response(
      JSON.stringify({
        statusCode: '400',
        error: 'Bad Request',
        message: 'fixture storage upload rejected',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }
  assert(url.startsWith('https://api.surge.app/'), `unexpected external request: ${url}`);
  if (failure === 'accepted-mms-persist') {
    assert.match(String(init?.body), /"attachments":\[\{"url":/);
  }
  providerSends++;
  if (failure === 'ambiguous')
    return new Response('fixture ambiguous provider result', { status: 502 });
  return new Response(JSON.stringify({ id: 'fixture-accepted-message' }), {
    headers: { 'content-type': 'application/json' },
  });
};

async function runCase(mode: Failure): Promise<void> {
  failure = mode;
  repaired = false;
  providerSends = 0;
  phoneLookups = 0;
  attachmentReads = 0;
  uploads = 0;
  const attentionId = randomUUID();
  const operationKey = `lifecycle-sms.write_lock:${attentionId}:initial`;
  const data = {
    user_id: randomUUID(),
    agent_id: randomUUID(),
    event_type: 'write_lock' as const,
  };
  const payload = {
    question: 'Approve this email?',
    attention_request_id: attentionId,
  };
  const preparationFailure = ['phone', 'attachment-body', 'upload', 'eligibility'].includes(mode);
  const firstPayload = [
    'attachment-body',
    'upload',
    'accepted-mms-persist',
    'eligibility',
  ].includes(mode)
    ? {
        ...payload,
        metadata: {
          writeLockNotification: {
            trigger_type: 'message',
            media: [{ url: 'https://write-lock-image.fixture.invalid/item.png' }],
          },
        },
      }
    : payload;
  if (mode === 'accepted') await dispatchWriteLockOnce(data, firstPayload, ['SMS']);
  else await assert.rejects(dispatchWriteLockOnce(data, firstPayload, ['SMS']), /fixture/);
  const initial = getRecord(operationKey).status;
  repaired = true;
  await dispatchWriteLockOnce(data, payload, ['SMS']);
  const final = getRecord(operationKey).status;
  process.stdout.write(
    JSON.stringify({
      mode,
      initial,
      final,
      providerSends,
      phoneLookups,
      attachmentReads,
      uploads,
    }) + '\n'
  );
  if (preparationFailure) {
    assert.equal(initial, 'FAILED', `${mode} failure before sending must be retryable`);
    assert.equal(final, 'SUCCEEDED', 'repaired retry must complete the reclaimed claim');
    assert.equal(providerSends, 1, 'only the repaired request may send');
    assert.equal(phoneLookups, 2, 'retry must repeat preparation');
  } else {
    assert.equal(initial, mode === 'accepted' ? 'SUCCEEDED' : 'STARTED');
    assert.equal(final, initial, 'uncertain or accepted delivery must retain the claim');
    assert.equal(providerSends, 1, 'uncertain or accepted delivery must never be resent');
    assert.equal(phoneLookups, 1, 'duplicate must skip preparation');
  }
}

async function main(): Promise<void> {
  let failed = 0;
  try {
    for (const [key, value] of Object.entries(testEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const mode of [
      'phone',
      'attachment-body',
      'upload',
      'eligibility',
      'ambiguous',
      'accepted-persist',
      'accepted-mms-persist',
      'accepted',
    ] as const) {
      try {
        await runCase(mode);
        process.stdout.write(`PASS ${mode}\n`);
      } catch (error) {
        failed++;
        process.stderr.write(
          `FAIL ${mode}: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }
  } finally {
    prisma.toolSideEffect.create = originals.create;
    prisma.toolSideEffect.findUniqueOrThrow = originals.findUniqueOrThrow;
    prisma.toolSideEffect.updateMany = originals.updateMany;
    prisma.toolSideEffect.update = originals.update;
    prisma.user.findUnique = originals.findUser;
    prisma.agent.findUnique = originals.findAgent;
    prisma.$executeRaw = originals.executeRaw;
    globalThis.fetch = originals.fetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.$disconnect();
  }
  if (failed) process.exitCode = 1;
  process.stdout.write(`write-lock claim regression: ${8 - failed} passed, ${failed} failed\n`);
}
void main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
