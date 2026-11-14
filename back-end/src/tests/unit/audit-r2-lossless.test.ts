#!/usr/bin/env tsx
/**
 * R2 lossless audit (V13) classification and checks against a local
 * TRACE_ARCHIVE_BACKEND=local archive with mocked DB inventory. A "lossy"
 * world must FAIL every named check that its defect targets (lost output,
 * unbound/child writes, misbound and non-v2 records, unfinalized roots,
 * unmirrored code checkpoints, unreadable ciphertext) while waived W1-W3
 * calls stay out of the failure counts; a clean v2 world must PASS.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  archiveBytes,
  archiveJson,
  encryptArtifact,
  storePlainArtifact,
} from '../../providers/traceArchive';
import {
  type AuditOptions,
  type CheckpointSource,
  type Inventory,
  type LedgerItem,
  type RootRow,
  archiveEncryptionKey,
  localArchiveSource,
  outputState,
  parseHead,
} from '../../../scripts/audit-r2-lossless-core';
import {
  type AuditReport,
  type CheckResult,
  runAudit,
} from '../../../scripts/audit-r2-lossless-engine';
import { loadRecordSchema, validateAgainstSchema } from '../../../scripts/audit-r2-lossless-schema';
import { listAllBundleIds, planBundleScan } from '../../../scripts/audit-r2-lossless';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-lossless-audit-'));
let directory = tempRoot;
process.env.NODE_ENV = 'test';
process.env.ENVIRONMENT = 'test';
process.env.TRACE_ARCHIVE_BACKEND = 'local';
process.env.TRACE_ARCHIVE_ENABLED = 'true';

/** Each scenario gets its own local archive root (read by the archive writer at call time). */
function useArchiveDir(name: string): void {
  directory = path.join(tempRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
}
process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 41).toString('base64');

const NOW = Date.now();
const HOUR = 3_600_000;
const schema = loadRecordSchema();
const uuid = () => crypto.randomUUID();
const hex = () => crypto.randomBytes(6).toString('hex');

function options(overrides: Partial<AuditOptions> = {}): AuditOptions {
  return {
    sinceMs: NOW - HOUR,
    untilMs: NOW + HOUR,
    nowMs: NOW + 2 * HOUR,
    v2CutoffMs: null,
    graceMs: 30 * 60_000,
    concurrency: 4,
    maxExamples: 5,
    headBytes: 1024,
    encryptionKey: archiveEncryptionKey(),
    schema,
    ...overrides,
  };
}

function root(id: string, status: string, overrides: Partial<RootRow> = {}): RootRow {
  return {
    id,
    createdAtMs: NOW - 3 * HOUR,
    updatedAtMs: NOW - 3 * HOUR,
    status,
    deleted: false,
    isBenchmark: false,
    model: 'rose-labs/rose-1-ultra',
    hasWorkflow: true,
    ...overrides,
  };
}

function ledger(rootId: string, toolName: string, extra: Partial<LedgerItem> = {}): LedgerItem {
  return {
    toolUsageId: uuid(),
    agentId: rootId,
    rootId,
    toolName,
    itemType: 'llm',
    callSite: toolName,
    provider: null,
    cacheSequenceId: null,
    fromFastCache: false,
    cancelled: false,
    ...extra,
  };
}

/** Loose encrypted object written the way an old/buggy writer did (bypasses the bound-root guard). */
function rawPut(bundle: string, objectPath: string, value: unknown): string {
  const encrypted = encryptArtifact(
    objectPath,
    Buffer.from(JSON.stringify(value)),
    'application/json'
  );
  assert.ok(encrypted);
  const target = path.join(directory, 'trace-archive', bundle, objectPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encrypted.ciphertext);
  fs.writeFileSync(`${target}.meta.json`, JSON.stringify(encrypted.metadata));
  return target;
}

async function put(rootId: string, objectPath: string, value: unknown): Promise<void> {
  assert.ok(await archiveJson({ rootAgentId: rootId, objectPath, value }));
}

async function finalizedBundle(rootId: string): Promise<void> {
  await put(rootId, 'db/start.fixture.json.gz.enc', { agent_ids: [rootId] });
  await put(rootId, 'db/end.fixture.json.gz.enc', { agent_ids: [rootId] });
  await put(rootId, 'manifest.json.gz.enc', { finalized: true });
  await storePlainArtifact({
    rootAgentId: rootId,
    objectPath: 'manifest.public.json',
    body: Buffer.from('{}'),
    contentType: 'application/json',
  });
}

/** Legacy Python layout: start in llm/, patch in llm-updates/<dump>-<ms>-update. */
async function legacyCall(
  rootId: string,
  callSite: string,
  patch: Record<string, unknown> | null,
  start: Record<string, unknown> = {}
): Promise<string> {
  const dumpId = hex();
  const ids = {
    agent_id: start.agent_id ?? rootId,
    root_agent_id: start.root_agent_id ?? rootId,
    span_id: start.span_id ?? hex(),
    dump_id: dumpId,
  };
  await put(rootId, `llm/${dumpId}.json.gz.enc`, {
    call_site: callSite,
    ...ids,
    model: 'rose-1-ultra',
    message_count: 1,
    messages: [{ role: 'user', content: 'hi' }],
    ...start,
  });
  if (patch !== null) {
    await put(rootId, `llm-updates/${dumpId}-${NOW}-update.json.gz.enc`, { ...ids, ...patch });
  }
  return dumpId;
}

const v2Output = (content: string) => ({
  content,
  reasoning: '',
  reasoning_blocks: [{ type: 'anthropic_thinking', text: 'think', signature: 'sig' }],
  tool_calls: [],
  usage: { prompt: 10, completion: 5, reasoning: 2 },
  actual_model: 'claude-opus-5-5',
});

async function v2Call(
  rootId: string,
  callSite: string,
  output: Record<string, unknown>
): Promise<string> {
  const dumpId = uuid();
  const identity = {
    schema_version: 2,
    call_site: callSite,
    agent_id: rootId,
    root_agent_id: rootId,
    span_id: hex(),
    dump_id: dumpId,
  };
  await put(rootId, `llm/${dumpId}.json.gz.enc`, {
    ...identity,
    record: 'start',
    started_at_ms: NOW,
    model: 'rose-1-ultra',
    message_count: 1,
    messages: [{ role: 'user', content: 'hi' }],
    config: {},
  });
  await put(rootId, `llm-updates/${dumpId}-${NOW}-${callSite}.json.gz.enc`, {
    ...identity,
    record: 'final',
    finished_at_ms: NOW,
    output,
  });
  return dumpId;
}

function check(report: AuditReport, id: string): CheckResult {
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `missing check ${id}`);
  return found;
}

function emptyScan(): NonNullable<Inventory['bundleScan']> {
  return {
    totalBundles: 0,
    nonUuid: [],
    userRootBundles: [],
    childAgentBundles: [],
    unknownUuidTotal: 0,
    newUnknownUuid: [],
    sampledUnknownUuid: [],
    snapshotAvailable: true,
  };
}

function checkpointSource(seqs: Record<string, number[]>, artifacts: string[]): CheckpointSource {
  return {
    listSeqs: async (_userId, sessionId) => seqs[sessionId] ?? [],
    readManifest: async () => ({
      artifacts: Object.fromEntries(artifacts.map((a) => [a, { sha256: 'x', size: 1 }])),
    }),
  };
}

async function mirrorSeq(
  rootId: string,
  sessionId: string,
  seq: number,
  names: string[]
): Promise<void> {
  for (const name of names) {
    assert.ok(
      await archiveBytes({
        rootAgentId: rootId,
        objectPath: `code/${sessionId}/${seq}/${name}`,
        body: Buffer.from(name),
        contentType: 'application/octet-stream',
        createOnly: true,
      })
    );
  }
}

async function testPrimitives(): Promise<void> {
  assert.equal(
    outputState({ output: { content: '', tool_calls: [{ name: 'x', arguments: {} }] } }),
    'content'
  );
  assert.equal(
    outputState({ output: { content: '', tool_calls: [], usage: { prompt: 1 } } }),
    'empty'
  );
  assert.equal(outputState({ extra: { tool_calls: [{ name: 'x' }] } }), 'content');
  assert.equal(outputState({ messages: [] }), 'absent');
  const head = parseHead(
    '{"call_site":"plan_loop","agent_id":"a","root_agent_id":"r","span_id":"s","messages":[{"call_site":"x"'
  );
  assert.deepEqual(head, {
    call_site: 'plan_loop',
    agent_id: 'a',
    root_agent_id: 'r',
    span_id: 's',
  });
  assert.equal(parseHead('{"messages":[{"call_site":"inner"}],"call_site":"late"'), null);

  const identity = {
    schema_version: 2,
    call_site: 'planner',
    agent_id: 'a',
    root_agent_id: 'r',
    span_id: 's',
    dump_id: 'd',
  };
  const start = {
    ...identity,
    record: 'start',
    started_at_ms: 1,
    model: null,
    message_count: 0,
    messages: [],
    config: {},
  };
  const final = { ...identity, record: 'final', finished_at_ms: 2, output: v2Output('ok') };
  assert.deepEqual(validateAgainstSchema(schema, start), []);
  assert.deepEqual(validateAgainstSchema(schema, final), []);
  assert.ok(
    validateAgainstSchema(schema, { ...final, agent_id: 'unbound' }).some((e) =>
      e.includes('agent_id')
    )
  );
  assert.ok(
    validateAgainstSchema(schema, { ...final, output: { content: 'x' } }).some((e) =>
      e.includes('usage')
    )
  );
  assert.ok(validateAgainstSchema(schema, { ...start, schema_version: 1 }).length > 0);
}

async function testLossyWorld(): Promise<void> {
  useArchiveDir('lossy');
  const rootA = uuid();
  const rootB = uuid();
  const rootC = uuid();
  const childA = uuid();
  const hubRoot = uuid();
  await finalizedBundle(rootA);
  await put(rootB, 'db/start.fixture.json.gz.enc', { agent_ids: [rootB] });

  await legacyCall(rootA, 'execute_loop', { output: { content: 'done' } });
  const bigSpan = hex();
  await legacyCall(rootA, 'execute_loop', null, { span_id: bigSpan, extra: { attempt: 1 } });
  await legacyCall(
    rootA,
    'execute_loop',
    { output: 'retried' },
    {
      span_id: bigSpan,
      messages: [{ role: 'user', content: crypto.randomBytes(20_000).toString('hex') }],
    }
  );
  // TS chat layout: one combined record, output inline.
  await put(rootA, `llm/${uuid()}.json.gz.enc`, {
    call_site: 'chat_router_after_search',
    agent_id: rootA,
    root_agent_id: rootA,
    messages: [],
    output: '{"action":"direct_answer"}',
  });
  const lost = await legacyCall(rootA, 'plan_loop', null); // >1 MB output dropped: start only
  // W2: a replay carries output but is not a live call; same for a scrape passthrough.
  await legacyCall(
    rootA,
    'explore_agent',
    { output: { content: 'replayed' } },
    { extra: { completion_source: 'demo_cache', replay_reason: 'hit' } }
  );
  await legacyCall(rootA, 'summarize_web_fetch', {
    output: { content: 'summary', actual_model: 'fast-mode-scrape-passthrough' },
  });
  await legacyCall(rootA, 'verifier_execute', {
    extra: { error: { type: 'CancelledError', message: 'cancelled' } },
  });
  await legacyCall(rootA, 'dag_param_populator', {
    extra: { error: { type: 'RateLimitError', message: '429' } },
  });
  await legacyCall(rootA, 'summarize_web_fetch', { output: 'x' }, { agent_id: childA });
  await legacyCall(rootA, 'wait_for', { output: 'x' }, { root_agent_id: 'some-other-root' });
  const corrupt = await legacyCall(rootA, 'completion_summary', { output: 'x' });
  const corruptPath = path.join(directory, `trace-archive/${rootA}/llm-updates`);
  const corruptFile = fs
    .readdirSync(corruptPath)
    .find((n) => n.startsWith(corrupt) && n.endsWith('.enc'));
  assert.ok(corruptFile);
  const target = path.join(corruptPath, corruptFile);
  const bytes = fs.readFileSync(target);
  bytes[0] ^= 0xff;
  fs.writeFileSync(target, bytes);
  await legacyCall(rootA, 'completion_summary', { output: 'kept' });

  // Loose writes: unbound (one in window, one stale) and a child-agent bundle.
  rawPut('unbound', `llm/${hex()}.json.gz.enc`, { call_site: 'planner' });
  const stale = rawPut('unbound', `llm/${hex()}.json.gz.enc`, { call_site: 'planner' });
  fs.utimesSync(stale, (NOW - 48 * HOUR) / 1000, (NOW - 48 * HOUR) / 1000);
  rawPut('user-42', `llm/${hex()}.json.gz.enc`, { call_site: 'planner' });
  rawPut(`user-${uuid()}`, `llm/${hex()}.json.gz.enc`, { call_site: 'sms_supervisor' });
  rawPut(childA, `llm/${hex()}.json.gz.enc`, { call_site: 'explore_agent' });
  // Bundles of ids with no prod Agent row: a declared benchmark run (OK), an isolated stack
  // with the fixture/manifest pattern but no Hub link (FAIL) and a loose dev/test write (FAIL).
  const benchRun = uuid();
  const isolatedRun = uuid();
  const devRun = uuid();
  rawPut(benchRun, 'db/start.fixture.json.gz.enc', {});
  fs.writeFileSync(
    path.join(directory, 'trace-archive', benchRun, 'manifest.public.json'),
    JSON.stringify({ root_agent_id: benchRun, benchmark_task_name: 'blue-bottle' })
  );
  // Isolated stack without archive lifecycle: only pipeline records bound to its own id.
  rawPut(isolatedRun, `llm/${hex()}.json.gz.enc`, {
    call_site: 'execute_loop',
    agent_id: isolatedRun,
    root_agent_id: isolatedRun,
  });
  rawPut(devRun, `llm/${hex()}.json.gz.enc`, { call_site: 'test-cut-off-recovery' });
  rawPut(hubRoot, 'db/start.fixture.json.gz.enc', {});
  // A legacy patch without call_site is attributed through its (older) start record.
  const looseDump = hex();
  const oldStart = rawPut('unbound', `llm/${looseDump}.json.gz.enc`, { call_site: 'cache_warmup' });
  fs.utimesSync(oldStart, (NOW - 48 * HOUR) / 1000, (NOW - 48 * HOUR) / 1000);
  rawPut('unbound', `llm-updates/${looseDump}-${NOW}-update.json.gz.enc`, { output: 'x' });

  // Code session: seq 1 mirrored, seq 2 missing worktree, latest seq 3 lost, seq 4 R2-only complete.
  const session = uuid();
  const artifacts = ['cli-log.jsonl', 'worktree.tar.gz'];
  await mirrorSeq(rootA, session, 1, ['manifest.json', ...artifacts]);
  await mirrorSeq(rootA, session, 2, ['manifest.json', 'cli-log.jsonl']);
  await put(rootA, `code/${session}/4/manifest.json`, { artifacts: { 'cli-log.jsonl': {} } });
  await mirrorSeq(rootA, session, 4, ['cli-log.jsonl']);

  const inventory: Inventory = {
    roots: [
      root(rootA, 'COMPLETED'),
      root(rootB, 'FAILED', { hasWorkflow: false }),
      root(rootC, 'ACTIVE'),
    ],
    hubRoots: [root(hubRoot, 'COMPLETED', { model: 'benchmark-hub' })],
    treeAgents: [{ id: childA, rootId: rootA }],
    activeChildren: [childA],
    ledger: [
      ledger(rootA, 'execute_loop'),
      ledger(rootA, 'execute_loop'),
      ledger(rootA, 'chat_router', { callSite: 'chat' }),
      ledger(rootA, 'planner'), // ledgered call with no record at all
      ledger(rootA, 'explore_agent', { fromFastCache: true }),
      ledger(rootA, 'explore_agent', { itemType: 'service' }),
    ],
    codeSessions: [
      { id: session, userId: 'u', rootAgentId: rootA, state: 'ACTIVE', latestCheckpointSeq: 3 },
    ],
    // Real sharded listing of the local archive, classified against the mocked DB membership.
    bundleScan: planBundleScan(
      await listAllBundleIds(localArchiveSource(directory), 4),
      [
        { id: rootA, is_root: true, model: 'rose-labs/rose-1-ultra' },
        { id: rootB, is_root: true, model: 'rose-labs/rose-1-ultra' },
        { id: childA, is_root: false, model: 'rose-labs/rose-1-flash' },
        { id: hubRoot, is_root: true, model: 'benchmark-hub' },
      ],
      new Map(),
      NOW - HOUR,
      10,
      false
    ),
  };
  const audit = (v2CutoffMs: number | null) =>
    runAudit(
      inventory,
      localArchiveSource(directory),
      checkpointSource({ [session]: [1, 2] }, artifacts),
      options({ v2CutoffMs })
    );
  const report = await audit(null);

  assert.equal(report.result, 'FAIL');
  const c0 = check(report, 'C0');
  assert.equal(c0.status, 'FAIL');
  assert.equal(c0.counts.unreadable, 1);
  assert.match(c0.summary, /head_only=1\b/);

  const c1 = check(report, 'C1');
  assert.equal(c1.status, 'FAIL');
  assert.deepEqual([c1.counts.finalized, c1.counts.unfinalized, c1.counts.nonterminal], [1, 1, 1]);
  assert.deepEqual(c1.examples['no_end_fixture:chat:FAILED'], [rootB]);

  const c2 = check(report, 'C2');
  assert.equal(c2.status, 'FAIL');
  assert.equal(c2.counts.missing_output, 1);
  assert.deepEqual(c2.examples['missing_output:plan_loop'], [`${rootA}/${lost}`]);
  assert.equal(c2.counts.cache_replay, 1);
  assert.equal(c2.counts.passthrough, 1);
  assert.deepEqual(report.misses.map((m) => [m.kind, m.call_site, m.agent_ids.join(',')]).sort(), [
    ['ledger_unarchived', 'planner', rootA],
    ['missing_output', 'plan_loop', rootA],
  ]);
  assert.equal(c2.counts.cancelled, 1);
  assert.equal(c2.counts.failed, 1);
  assert.equal(c2.counts.superseded_attempt, 1);
  assert.equal(c2.counts.ledger_live, 4);
  assert.equal(c2.counts.ledger_unarchived, 1);
  assert.ok(c2.examples['ledger_missing:planner']?.[0]?.startsWith(rootA));
  const chatRow = report.call_sites.find((r) => r.family === 'chat_router');
  assert.deepEqual([chatRow?.ledger_live, chatRow?.ledger_missing], [1, 0]);

  const c3 = check(report, 'C3');
  const loose = report.loose_write_summary.map((r) => [r.scope, r.call_site, r.objects]);
  assert.deepEqual(loose.sort(), [
    ['child', 'explore_agent', 1],
    ['junk', 'cache_warmup', 1],
    ['junk', 'planner', 2],
    ['unknown_new', 'db/*', 1],
    ['unknown_new', 'execute_loop', 1],
    ['unknown_new', 'manifest.public.json', 1],
    ['unknown_new', 'test-cut-off-recovery', 1],
  ]);
  assert.ok(report.loose_writes.every((w) => w.last_modified.length === 24));
  assert.deepEqual(
    [
      c3.counts.unknown_benchmark_ok,
      c3.counts.unknown_isolated_unlinked,
      c3.counts.unknown_devtest,
    ],
    [1, 1, 1]
  );
  assert.match(
    c3.examples.unknown_benchmark_ok?.[0] ?? '',
    new RegExp(`${benchRun}.*task blue-bottle`)
  );
  assert.match(c3.examples.unknown_isolated_unlinked?.[0] ?? '', new RegExp(isolatedRun));
  assert.match(c3.examples.unknown_isolated_unlinked?.[0] ?? '', /call_sites execute_loop/);
  assert.match(
    c3.examples.unknown_devtest?.[0] ?? '',
    new RegExp(`${devRun}.*test-cut-off-recovery`)
  );
  assert.equal(c3.status, 'FAIL');
  assert.equal(c3.counts.junk_bundles_checked, 2); // unbound + user-42; user-<uuid> is a documented root
  assert.equal(c3.counts.junk_objects_written, 3);
  assert.equal(c3.counts.user_root_bundles, 1);
  assert.equal(c3.counts.child_objects_written, 1);
  assert.equal(c3.counts.misbound_records, 2); // start + update of the misbound call
  assert.ok(c3.counts.agent_outside_tree_records === 0);

  assert.equal(check(report, 'C4').status, 'SKIP');
  // With a v2 cutoff before these writes, every legacy record is reported as not v2.
  const c4 = check(await audit(NOW - 2 * HOUR), 'C4');
  assert.equal(c4.status, 'FAIL');
  assert.equal(c4.counts.invalid, 0);
  assert.ok(c4.counts.not_v2 > 10, c4.summary);

  const c5 = check(report, 'C5');
  assert.equal(c5.status, 'FAIL');
  assert.deepEqual(
    [
      c5.counts.mirrored,
      c5.counts.unmirrored,
      c5.counts.latest_lost,
      c5.counts.r2_only,
      c5.counts.r2_incomplete,
    ],
    [1, 1, 1, 1, 0]
  );
  assert.match(c5.examples.unmirrored?.[0] ?? '', /\/2 missing worktree\.tar\.gz/);

  const c6 = check(report, 'C6');
  assert.equal(report.backend_call_sites.find((r) => r.site === 'chat_router')?.status, 'PASS');
  assert.equal(
    report.backend_call_sites.find((r) => r.site === 'sms_supervisor')?.status,
    'UNVERIFIED'
  );
  assert.equal(c6.status, 'UNVERIFIED');
  assert.deepEqual(report.benchmark_hub, {
    placeholders: 1,
    with_bundle: 1,
    written_in_window_ok: 1,
  });
}

async function testCleanWorld(): Promise<void> {
  useArchiveDir('clean');
  const rootId = uuid();
  await finalizedBundle(rootId);
  await v2Call(rootId, 'chat_router', v2Output('{"action":"direct_answer"}'));
  await v2Call(rootId, 'planner', v2Output('plan'));
  const session = uuid();
  await mirrorSeq(rootId, session, 1, ['manifest.json', 'cli-log.jsonl']);
  const inventory: Inventory = {
    roots: [root(rootId, 'COMPLETED')],
    hubRoots: [],
    treeAgents: [],
    activeChildren: [],
    ledger: [ledger(rootId, 'chat_router'), ledger(rootId, 'planner')],
    codeSessions: [
      { id: session, userId: 'u', rootAgentId: rootId, state: 'PAUSED', latestCheckpointSeq: 1 },
    ],
    bundleScan: emptyScan(),
  };
  const report = await runAudit(
    inventory,
    localArchiveSource(directory),
    checkpointSource({ [session]: [1] }, ['cli-log.jsonl']),
    options({ v2CutoffMs: NOW - 2 * HOUR })
  );
  for (const id of ['C0', 'C1', 'C2', 'C3', 'C4', 'C5']) {
    assert.equal(check(report, id).status, 'PASS', `${id}: ${check(report, id).summary}`);
  }
  assert.equal(check(report, 'C4').counts.checked, 4);
  assert.equal(check(report, 'C6').status, 'UNVERIFIED');
  assert.equal(report.result, 'PASS');

  // A v2 final that drops output.usage and binds to `unbound` is rejected.
  await put(rootId, `llm-updates/${uuid()}-${NOW}-planner.json.gz.enc`, {
    schema_version: 2,
    record: 'final',
    call_site: 'planner',
    agent_id: 'unbound',
    root_agent_id: rootId,
    span_id: 's',
    dump_id: 'd',
    finished_at_ms: NOW,
    output: { content: 'x', reasoning: '', tool_calls: [], actual_model: null },
  });
  const after = await runAudit(
    inventory,
    localArchiveSource(directory),
    checkpointSource({ [session]: [1] }, ['cli-log.jsonl']),
    options({ v2CutoffMs: NOW - 2 * HOUR })
  );
  assert.equal(check(after, 'C4').status, 'FAIL');
  assert.equal(check(after, 'C4').counts.invalid, 1);
}

async function main(): Promise<void> {
  try {
    await testPrimitives();
    await testLossyWorld();
    await testCleanWorld();
    process.stdout.write('audit-r2-lossless: all tests passed\n');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
