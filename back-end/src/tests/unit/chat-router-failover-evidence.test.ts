import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureLiveEvidence,
  type LiveEvidenceCapture,
  withEvidenceCleanup,
  assertLiveSampleHasNoSecrets,
} from '../blackbox/chat-router-failover.evidence.support';

const ROOT_ID = '1966bd77-d3ae-47f9-b93b-a96d5818d933';
const CHILD_ID = 'c1f0e12e-d2f9-4b95-80fd-7231ec1eb39a';
const FOREIGN_ID = '2f46b57f-3594-4355-9dbe-6dfd2e48b59e';
const HISTORICAL_ID = '63859e11-d807-487e-ab74-5b994e324384';
const timestamp = new Date('2026-10-06T21:00:00Z');
const message = {
  id: '856e03ad-d099-46f5-8c0c-1bb64776430e',
  role: 'TOOL',
  text: '',
  timestamp,
  metadata: { toolName: 'spawn_agent', agentId: HISTORICAL_ID },
  filePointer: { id: 'offline-attachment', storage_path: 'offline-path' },
};
const rows = [
  {
    id: ROOT_ID,
    userId: 'owned-user',
    parentAgentId: null,
    status: 'RUNNING',
    goal: 'offline root',
    messages: [message],
    toolUsages: [],
    fastModeCacheEnabled: true,
    worldModelMode: 'real',
  },
  {
    id: CHILD_ID,
    userId: 'owned-user',
    parentAgentId: ROOT_ID,
    status: 'COMPLETED',
    goal: 'offline actual child',
    messages: [{ ...message, id: 'actual-child-message', text: 'actual child message' }],
    toolUsages: [],
  },
  {
    id: FOREIGN_ID,
    userId: 'foreign-user',
    parentAgentId: ROOT_ID,
    status: 'RUNNING',
    goal: 'must never publish',
    messages: [],
    toolUsages: [],
  },
];
const db = {
  agent: {
    findUniqueOrThrow: async () => rows[0],
    findMany: async ({
      where,
      select,
    }: {
      where: { userId: string; id?: { in: string[] }; parentAgentId?: { in: (string | null)[] } };
      select?: { id: boolean };
    }) => {
      const found = rows.filter(
        (row) =>
          row.userId === where.userId &&
          (where.id
            ? where.id.in.includes(row.id)
            : (where.parentAgentId?.in.includes(row.parentAgentId) ?? false))
      );
      return select ? found.map((row) => ({ id: row.id })) : found;
    },
  },
  browserSession: { findMany: async () => [] },
};

async function main(): Promise<void> {
  assertLiveSampleHasNoSecrets(
    { glm: [{ model: 'glm', status: 200, firstContentMs: 2398, sessionId: 'synthetic-session' }] },
    {}
  );
  assert.throws(
    () => assertLiveSampleHasNoSecrets({ glm: [{ authorization: 'offline fake header' }] }, {}),
    /publication refused/
  );
  assert.throws(
    () =>
      assertLiveSampleHasNoSecrets(
        { glm: [{ note: 'offline-credential-123456' }] },
        { OPENROUTER_API_KEY: 'offline-credential-123456' }
      ),
    /publication refused/
  );
  const original = new Error('original model first-attempt assertion: 2 !== 1');
  const publisher = new Error('publisher failed closed');
  await assert.rejects(
    withEvidenceCleanup(
      async () => {
        throw original;
      },
      async () => {
        throw publisher;
      }
    ),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors[0] === original &&
      error.errors[1] === publisher &&
      error.cause === original &&
      error.message.includes('2 !== 1') &&
      error.message.includes('publisher failed closed')
  );
  await assert.rejects(
    withEvidenceCleanup(
      async () => ({ attempts: 2 }),
      async () => {
        throw publisher;
      },
      () => {
        throw original;
      }
    ),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors[0] === original &&
      error.errors[1] === publisher,
    'a publisher failure before outer probe verdict must retain the existing model verdict too'
  );
  await assert.rejects(
    withEvidenceCleanup(
      async () => {
        throw original;
      },
      async () => {}
    ),
    (error: unknown) => error === original
  );
  let checked = false;
  assert.equal(
    await withEvidenceCleanup(
      async () => 'unchanged success',
      async () => {},
      () => {
        checked = true;
      }
    ),
    'unchanged success'
  );
  assert.equal(
    checked,
    false,
    'normal cleanup never changes existing outer probe/retry verdict behavior'
  );
  const dir = mkdtempSync(join(tmpdir(), 'rose-chat-evidence-offline-'));
  try {
    const capture: LiveEvidenceCapture = {
      runId: '3c274efb-dc66-4605-830c-2c9b03fb664d',
      dir,
      startedAt: timestamp.toISOString(),
      label: 'offline capture control',
      gitSha: 'offline-control',
      sourceSha256: {},
      fixtureSha256: 'offline-fixture-control',
      sample: { outcome: { kind: 'escalated', atMs: 30015 }, attempts: 2 },
    };
    const path = await captureLiveEvidence(
      db as unknown as Parameters<typeof captureLiveEvidence>[0],
      ROOT_ID,
      capture
    );
    const bundle = JSON.parse(readFileSync(path, 'utf8'));
    const task = bundle.tasks[0];
    assert.equal(bundle.run_id, capture.runId);
    assert.equal(
      task.passed,
      null,
      'captured sample is never invented into a passing gate verdict'
    );
    assert.equal(task.status, 'evidence-only');
    assert.equal(task.logs.live_sample.attempts, 2);
    assert.deepEqual(Object.keys(task.logs.tree).sort(), [ROOT_ID, CHILD_ID].sort());
    assert.equal(task.logs.tree[ROOT_ID].status, 'RUNNING', 'preserve actual status');
    assert.equal(
      task.logs.tree[HISTORICAL_ID],
      undefined,
      'old fixture tool metadata must not invent a new child'
    );
    assert.equal(
      task.logs.tree[FOREIGN_ID],
      undefined,
      'another user must not enter the captured tree'
    );
    const actual = task.logs.messages[0];
    assert.equal(actual.message_id, message.id);
    assert.equal(actual.message, '', 'empty message content must remain exact');
    assert.deepEqual(actual.metadata, message.metadata);
    assert.deepEqual(actual.file_pointer, message.filePointer);
    assert.equal(actual.created_at, timestamp.toISOString());
    assert.deepEqual(task.logs.messages, task.logs.tree[ROOT_ID].messages);
    const raw = JSON.parse(readFileSync(join(dir, 'actual-db-rows.json'), 'utf8'));
    assert.equal(raw.agents.length, 2);
    assert.deepEqual(raw.browser_sessions, []);
    assert.ok(bundle.evidence_capture.provenance.includes('not newly executed sub-agents'));
    process.stdout.write(
      'PASS offline capture preserves actual ids/status/content/metadata/files and recorded miss; excludes foreign and historical-only children; preserves model plus publisher errors and unchanged outer verdict; no database/provider/publisher called\n'
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
