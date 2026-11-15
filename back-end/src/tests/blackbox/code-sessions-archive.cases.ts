/**
 * Lossless code-session trajectories (R2 trace archive), run inside
 * code-sessions.blackbox.ts with its local checkpoint store and a hermetic
 * local trace archive (TRACE_ARCHIVE_BACKEND=local, temp dir):
 *
 *   HOME CLI files ──checkpoint──► manifest.cliFiles (every file: path, sha256, holder)
 *     main transcript ──► cli-log.jsonl (cliSessionId: never a newer subagent file)
 *     other versions ──► cli-<sha256>, stored once (an unchanged file points at its seq)
 *   checkpoint ──archive job──► trace-archive/<tree root>/code/<id>/<seq>/<artifact>
 *   prune / retire ──► only checkpoints whose archive copy is confirmed;
 *     archive down or failing ──► checkpoint kept, session not retired, retried later
 *   retire with manifest.cliFilesDeferred ──► one more checkpoint captures them
 *     (archive confirmed) before the sandbox goes; capture fails ──► kept, unretired
 *   TTL sweep ──► pages past sessions whose retirement keeps failing (no starvation)
 *   backfill seq scan ──► every allocated seq, even far above the committed one
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { prisma } from '../../providers/database';
import { checkpointKey, getCheckpointObject } from '../../providers/codeSessions/artifactStore';
import {
  checkpointArchiveConfirmed,
  codeCheckpointArchivePath,
  waitForCodeSessionArchiveJobs,
} from '../../providers/codeSessions/archiveMirror';
import {
  CheckpointIntegrityError,
  loadVerifiedCheckpoint,
  type CheckpointManifest,
} from '../../providers/codeSessions/checkpoint';
import {
  checkpointCodeSession,
  checkpointSeqsToScan,
  createExpiredCodeSessionSweeper,
  localCodeSessionHome,
  retireCodeSession,
} from '../../providers/codeSessions/lifecycle';
import { localSandboxFs } from '../../providers/codeSessions/sandboxFs';
import { resolveSpawnCodeSession } from '../../providers/codeSessions/spawn';
import {
  decryptAndValidateArtifact,
  localObjectPath,
  readArchivedArtifactStrict,
} from '../../providers/traceArchive';

export interface CodeSessionArchiveContext {
  fixtureDir: string;
  /** Seeds `<home>/workspace` and the Claude transcript `<cliSessionId>.jsonl`. */
  seedWorkspace: (home: string) => unknown;
  cliSessionId: string;
}

const ARCHIVE_ENV = ['TRACE_ARCHIVE_BACKEND', 'TRACE_ARCHIVE_LOCAL_DIR', 'TRACE_ARCHIVE_ENABLED'];

const SLUG = '-home-user-workspace';

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function storedManifest(
  userId: string,
  codeSessionId: string,
  seq: number
): Promise<CheckpointManifest> {
  const raw = await getCheckpointObject(checkpointKey(userId, codeSessionId, seq, 'manifest.json'));
  assert.ok(raw, `checkpoint ${seq} has a manifest`);
  return JSON.parse(raw.toString('utf8')) as CheckpointManifest;
}

async function archived(rootAgentId: string, objectPath: string): Promise<Buffer | null> {
  const stored = await readArchivedArtifactStrict({ rootAgentId, objectPath });
  return stored === null ? null : decryptAndValidateArtifact(stored);
}

/**
 * Every checkpoint of the suite is mirrored into a private local trace archive
 * (never R2); its background archive jobs settle before teardown.
 */
export function registerCodeSessionArchiveCases(ctx: CodeSessionArchiveContext): void {
  const archiveDir = join(ctx.fixtureDir, 'trace-archive-root');
  const saved = new Map(ARCHIVE_ENV.map((key) => [key, process.env[key]]));
  before(() => {
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = archiveDir;
    process.env.TRACE_ARCHIVE_ENABLED = '1';
  });
  after(async () => {
    await waitForCodeSessionArchiveJobs();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function withUser(fn: (userId: string) => Promise<void>): Promise<void> {
    const userId = `code-session-archive-${randomUUID()}`;
    await prisma.user.create({ data: { userId, name: 'Code Session Archive' } });
    try {
      await fn(userId);
    } finally {
      await waitForCodeSessionArchiveJobs();
      await prisma.codeSession.deleteMany({ where: { userId } });
      await prisma.agent.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { userId } });
    }
  }

  async function newSession(
    userId: string,
    rootAgentId: string,
    codeProvider: 'claude' | 'codex' = 'claude'
  ) {
    return prisma.codeSession.create({
      data: {
        userId,
        rootAgentId,
        ownerAgentId: rootAgentId,
        repoKey: `archive-${randomUUID()}`,
        codeProvider,
        state: 'PAUSED',
      },
    });
  }

  async function save(sessionId: string, home: string, agentId: string) {
    const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: sessionId } });
    const result = await checkpointCodeSession({
      session: row,
      fs: localSandboxFs(home),
      reason: 'close',
      agentId,
    });
    assert.ok(result, 'checkpoint must succeed');
    return result;
  }

  /** Every object of checkpoint `seq` is in the root bundle with its exact bytes (read from R2 alone). */
  async function assertArchivedCheckpoint(
    rootAgentId: string,
    codeSessionId: string,
    seq: number
  ): Promise<CheckpointManifest> {
    const manifestBytes = await archived(
      rootAgentId,
      codeCheckpointArchivePath(codeSessionId, seq, 'manifest.json')
    );
    assert.ok(manifestBytes, `seq ${seq} manifest is archived`);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as CheckpointManifest;
    for (const [name, expected] of Object.entries(manifest.artifacts)) {
      const body = await archived(rootAgentId, codeCheckpointArchivePath(codeSessionId, seq, name));
      assert.ok(body, `seq ${seq} ${name} is archived`);
      assert.equal(sha256(body), expected.sha256, `seq ${seq} ${name} archived intact`);
    }
    assert.ok(
      await checkpointArchiveConfirmed({
        target: { userId: manifest.userId, codeSessionId, rootAgentId },
        seq,
        manifestBytes,
      })
    );
    return manifest;
  }

  test('a checkpoint keeps every Claude CLI file once per version; cli-log.jsonl stays the main session even when a subagent file is newer', async () => {
    await withUser(async (userId) => {
      const home = join(ctx.fixtureDir, `home-cli-files-${randomUUID()}`);
      ctx.seedWorkspace(home);
      const project = join(home, '.claude', 'projects', SLUG);
      const sessionDir = join(project, ctx.cliSessionId);
      const olderSession = randomUUID();
      const subagent = join(sessionDir, 'subagents', 'agent-a1.jsonl');
      write(subagent, `${JSON.stringify({ type: 'user', isSidechain: true, n: 1 })}\n`);
      write(join(sessionDir, 'subagents', 'agent-a1.meta.json'), '{"agentType":"explore"}');
      write(join(sessionDir, 'tool-results', 'toolu_1.txt'), 'large tool output\n');
      write(join(project, `${olderSession}.jsonl`), '{"type":"user","resumed":"from here"}\n');
      const rollout = join(home, '.codex', 'sessions', '2026', '11', '14', 'rollout-a.jsonl');
      write(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-1' } })}\n`);
      const past = new Date(Date.now() - 3_600_000);
      utimesSync(join(project, `${olderSession}.jsonl`), past, past);
      // The newest file in the projects tree is a subagent transcript.
      const future = new Date(Date.now() + 60_000);
      utimesSync(subagent, future, future);

      const agentId = randomUUID();
      const session = await newSession(userId, agentId);
      const first = await save(session.id, home, agentId);
      assert.equal(first.cliSessionId, ctx.cliSessionId, 'resume id is the main session');

      const m1 = await storedManifest(userId, session.id, 1);
      assert.equal(m1.cliLogPath, `.claude/projects/${SLUG}/${ctx.cliSessionId}.jsonl`);
      const expected = [
        `.claude/projects/${SLUG}/${ctx.cliSessionId}.jsonl`,
        `.claude/projects/${SLUG}/${ctx.cliSessionId}/subagents/agent-a1.jsonl`,
        `.claude/projects/${SLUG}/${ctx.cliSessionId}/subagents/agent-a1.meta.json`,
        `.claude/projects/${SLUG}/${ctx.cliSessionId}/tool-results/toolu_1.txt`,
        `.claude/projects/${SLUG}/${olderSession}.jsonl`,
        '.codex/sessions/2026/11/14/rollout-a.jsonl',
      ].sort();
      assert.deepEqual((m1.cliFiles ?? []).map((file) => file.path).sort(), expected);
      for (const file of m1.cliFiles ?? []) {
        assert.equal(file.sha256, sha256(readFileSync(join(home, file.path))), file.path);
        assert.equal(file.seq, 1);
        assert.equal(m1.artifacts[file.artifact]?.sha256, file.sha256, `${file.path} is stored`);
      }
      const main = (m1.cliFiles ?? []).find((file) => file.path === m1.cliLogPath);
      assert.equal(main?.artifact, 'cli-log.jsonl');

      // Second checkpoint: the main and subagent transcripts grew, a tool result was added.
      appendFileSync(join(project, `${ctx.cliSessionId}.jsonl`), '{"type":"assistant","n":2}\n');
      appendFileSync(subagent, `${JSON.stringify({ type: 'assistant', isSidechain: true })}\n`);
      write(join(sessionDir, 'tool-results', 'toolu_2.txt'), 'second output\n');
      await save(session.id, home, agentId);
      const m2 = await storedManifest(userId, session.id, 2);
      const byPath = new Map((m2.cliFiles ?? []).map((file) => [file.path, file]));
      assert.equal(byPath.size, expected.length + 1);
      for (const unchanged of [
        `.claude/projects/${SLUG}/${ctx.cliSessionId}/subagents/agent-a1.meta.json`,
        `.claude/projects/${SLUG}/${ctx.cliSessionId}/tool-results/toolu_1.txt`,
        `.claude/projects/${SLUG}/${olderSession}.jsonl`,
        '.codex/sessions/2026/11/14/rollout-a.jsonl',
      ]) {
        assert.equal(byPath.get(unchanged)?.seq, 1, `${unchanged} is referenced, not stored again`);
      }
      const storedBlobs = Object.keys(m2.artifacts).filter((name) => name.startsWith('cli-'));
      assert.deepEqual(
        storedBlobs.sort(),
        [
          'cli-log.jsonl',
          `cli-${sha256(readFileSync(subagent))}`,
          `cli-${sha256('second output\n')}`,
        ].sort(),
        'seq 2 stores only the new versions'
      );
      // Every file of seq 2 reconstructs from storage, wherever its version lives.
      for (const file of m2.cliFiles ?? []) {
        const body = await getCheckpointObject(
          checkpointKey(userId, session.id, file.seq, file.artifact)
        );
        assert.ok(body, `${file.path} version is held by seq ${file.seq}`);
        assert.equal(sha256(body), sha256(readFileSync(join(home, file.path))), file.path);
      }
    });
  });

  test('a Codex checkpoint resumes the main rollout, never a newer sub-agent thread, and keeps both', async () => {
    await withUser(async (userId) => {
      const home = join(ctx.fixtureDir, `home-codex-${randomUUID()}`);
      mkdirSync(home, { recursive: true });
      const day = join(home, '.codex', 'sessions', '2026', '11', '14');
      const mainId = randomUUID();
      const subId = randomUUID();
      const mainPath = join(day, `rollout-2026-11-14T10-00-00-${mainId}.jsonl`);
      const subPath = join(day, `rollout-2026-11-14T10-05-00-${subId}.jsonl`);
      write(
        mainPath,
        `${JSON.stringify({ type: 'session_meta', payload: { session_id: mainId, id: mainId, source: 'exec' } })}\n`
      );
      write(
        subPath,
        `${JSON.stringify({
          type: 'session_meta',
          payload: {
            session_id: mainId,
            id: subId,
            parent_thread_id: mainId,
            source: { subagent: { thread_spawn: { parent_thread_id: mainId } } },
          },
        })}\n`
      );
      const future = new Date(Date.now() + 60_000);
      utimesSync(subPath, future, future);
      const agentId = randomUUID();
      const session = await newSession(userId, agentId, 'codex');
      const result = await save(session.id, home, agentId);
      assert.equal(result.cliSessionId, mainId);
      const manifest = await storedManifest(userId, session.id, 1);
      assert.equal(
        manifest.cliLogPath,
        `.codex/sessions/2026/11/14/rollout-2026-11-14T10-00-00-${mainId}.jsonl`
      );
      assert.deepEqual((manifest.cliFiles ?? []).map((file) => file.path).sort(), [
        `.codex/sessions/2026/11/14/rollout-2026-11-14T10-00-00-${mainId}.jsonl`,
        `.codex/sessions/2026/11/14/rollout-2026-11-14T10-05-00-${subId}.jsonl`,
      ]);
    });
  });

  test("every checkpoint is mirrored into the tree root's bundle, also for a session keyed by a sub-agent", async () => {
    await withUser(async (userId) => {
      const root = await prisma.agent.create({ data: { userId, goal: 'archive root' } });
      // A sub-agent without busId: its session's rootAgentId would be the sub-agent.
      const child = await prisma.agent.create({
        data: { userId, goal: 'archive child', parentAgentId: root.id, depth: 1 },
      });
      const home = join(ctx.fixtureDir, `home-mirror-${randomUUID()}`);
      ctx.seedWorkspace(home);
      const session = await newSession(userId, child.id);
      await save(session.id, home, child.id);
      await waitForCodeSessionArchiveJobs();
      const manifest = await assertArchivedCheckpoint(root.id, session.id, 1);
      for (const name of [...Object.keys(manifest.artifacts), 'manifest.json']) {
        const original = await getCheckpointObject(checkpointKey(userId, session.id, 1, name));
        const copy = await archived(root.id, codeCheckpointArchivePath(session.id, 1, name));
        assert.ok(original && copy && original.equals(copy), `${name} archived byte-for-byte`);
      }
      assert.ok(
        !existsSync(join(archiveDir, 'trace-archive', child.id)),
        'nothing lands in a non-root bundle'
      );
    });
  });

  test('a spawn by a sub-agent without busId keys its session by the tree root', async () => {
    await withUser(async (userId) => {
      const root = await prisma.agent.create({ data: { userId, goal: 'spawn root' } });
      const mid = await prisma.agent.create({
        data: { userId, goal: 'spawn mid', parentAgentId: root.id, depth: 1 },
      });
      const leaf = await prisma.agent.create({
        data: { userId, goal: 'spawn leaf', parentAgentId: mid.id, depth: 2 },
      });
      const session = await resolveSpawnCodeSession({
        agentId: leaf.id,
        userId,
        repoUrl: null,
        codeProvider: 'claude',
        leaseOwner: `tool:leaf:${randomUUID()}`,
      });
      assert.equal(session?.rootAgentId, root.id);
      assert.equal(session?.ownerAgentId, leaf.id);
    });
  });

  test('periodic saves keep a bounded number of checkpoints per session', async () => {
    await withUser(async (userId) => {
      const agentId = randomUUID();
      const home = join(ctx.fixtureDir, `home-prune-${randomUUID()}`);
      ctx.seedWorkspace(home);
      const session = await newSession(userId, agentId);
      for (let i = 0; i < 8; i += 1) {
        writeFileSync(join(home, 'workspace', `save-${i}.txt`), `${i}\n`);
        assert.equal((await save(session.id, home, agentId)).seq, i + 1);
      }
      // Pruning runs after each checkpoint's archive mirror, off the close path.
      await waitForCodeSessionArchiveJobs();
      for (const seq of [1, 2, 3]) {
        await assert.rejects(
          loadVerifiedCheckpoint(userId, session.id, seq),
          CheckpointIntegrityError
        );
      }
      for (const seq of [4, 5, 6, 7, 8]) {
        assert.equal((await loadVerifiedCheckpoint(userId, session.id, seq)).manifest.seq, seq);
      }
    });
  });

  test('pruning and retirement keep every checkpoint whose archive copy is not confirmed; a later pass archives, then deletes', async () => {
    await withUser(async (userId) => {
      const agentId = randomUUID();
      const home = join(ctx.fixtureDir, `home-gate-${randomUUID()}`);
      ctx.seedWorkspace(home);
      const session = await newSession(userId, agentId);
      const storageDir = (seq: number) =>
        join(
          process.env.CODE_SESSION_STORAGE_LOCAL_DIR ?? '',
          dirname(checkpointKey(userId, session.id, seq, 'manifest.json'))
        );
      const previous = process.env.TRACE_ARCHIVE_ENABLED;
      process.env.TRACE_ARCHIVE_ENABLED = '0';
      try {
        for (let i = 0; i < 7; i += 1) {
          writeFileSync(join(home, 'workspace', `gate-${i}.txt`), `${i}\n`);
          await save(session.id, home, agentId);
        }
        await waitForCodeSessionArchiveJobs();
        for (let seq = 1; seq <= 7; seq += 1) {
          assert.ok(
            existsSync(join(storageDir(seq), 'manifest.json')),
            `unarchived seq ${seq} kept`
          );
        }
        const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
        await assert.rejects(retireCodeSession(row), /disabled/);
      } finally {
        if (previous === undefined) delete process.env.TRACE_ARCHIVE_ENABLED;
        else process.env.TRACE_ARCHIVE_ENABLED = previous;
      }
      // Archive enabled but its writes fail: still kept, still not retired.
      const bundle = join(archiveDir, 'trace-archive', agentId);
      write(bundle, 'not a directory');
      try {
        const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
        await assert.rejects(retireCodeSession(row));
        assert.ok(existsSync(join(storageDir(1), 'manifest.json')), 'a failed archive keeps it');
        const held = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
        assert.notEqual(held.state, 'RETIRED');
      } finally {
        rmSync(bundle, { force: true });
      }
      // Recovered: the next checkpoint archives itself and prunes seq 3 once archived.
      writeFileSync(join(home, 'workspace', 'gate-8.txt'), '8\n');
      await save(session.id, home, agentId);
      await waitForCodeSessionArchiveJobs();
      assert.ok(!existsSync(join(storageDir(3), 'manifest.json')), 'seq 3 pruned after archiving');
      assert.ok(existsSync(join(storageDir(1), 'manifest.json')), 'seq 1 waits for its own pass');
      const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
      await retireCodeSession(row);
      const retired = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
      assert.equal(retired.state, 'RETIRED');
      for (let seq = 1; seq <= 8; seq += 1) {
        const dir = storageDir(seq);
        assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], [], `seq ${seq} left storage`);
        await assertArchivedCheckpoint(agentId, session.id, seq);
      }
      assert.ok(existsSync(localObjectPath(agentId, `code/${session.id}/8/manifest.json`)));
    });
  });

  test('retire captures CLI files the last checkpoint deferred before destroying the sandbox; a failed capture keeps the session', async () => {
    await withUser(async (userId) => {
      const agentId = randomUUID();
      const created = await newSession(userId, agentId);
      const home = localCodeSessionHome(created.id);
      ctx.seedWorkspace(home);
      await prisma.codeSession.update({
        where: { id: created.id },
        data: { sandboxKind: 'local', homeDir: home },
      });
      // A close that ran out of budget: the file is listed as deferred, its bytes
      // exist only in the sandbox HOME. (Archive off so seq 1 is mirrored as rewritten.)
      const previous = process.env.TRACE_ARCHIVE_ENABLED;
      process.env.TRACE_ARCHIVE_ENABLED = '0';
      const deferredPath = `.claude/projects/${SLUG}/${ctx.cliSessionId}/subagents/agent-late.jsonl`;
      const deferredBody = `${JSON.stringify({ type: 'user', isSidechain: true, late: true })}\n`;
      try {
        await save(created.id, home, agentId);
        await waitForCodeSessionArchiveJobs();
        write(join(home, deferredPath), deferredBody);
        const m1 = await storedManifest(userId, created.id, 1);
        assert.ok(!(m1.cliFiles ?? []).some((file) => file.path === deferredPath));
        // The local store never overwrites, so the manifest is rewritten in place.
        writeFileSync(
          join(
            process.env.CODE_SESSION_STORAGE_LOCAL_DIR ?? '',
            checkpointKey(userId, created.id, 1, 'manifest.json')
          ),
          JSON.stringify({ ...m1, cliFilesDeferred: [deferredPath] })
        );
      } finally {
        if (previous === undefined) delete process.env.TRACE_ARCHIVE_ENABLED;
        else process.env.TRACE_ARCHIVE_ENABLED = previous;
      }

      // The retire-time capture fails (worktree over the artifact cap): nothing is destroyed.
      const cap = process.env.CODE_SESSION_CHECKPOINT_MAX_ARTIFACT_BYTES;
      process.env.CODE_SESSION_CHECKPOINT_MAX_ARTIFACT_BYTES = '1';
      try {
        const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: created.id } });
        await assert.rejects(retireCodeSession(row), /still has deferred CLI files/);
      } finally {
        if (cap === undefined) delete process.env.CODE_SESSION_CHECKPOINT_MAX_ARTIFACT_BYTES;
        else process.env.CODE_SESSION_CHECKPOINT_MAX_ARTIFACT_BYTES = cap;
      }
      const held = await prisma.codeSession.findUniqueOrThrow({ where: { id: created.id } });
      assert.notEqual(held.state, 'RETIRED');
      assert.ok(existsSync(join(home, deferredPath)), 'the sandbox HOME is kept');
      assert.ok(
        await getCheckpointObject(checkpointKey(userId, created.id, 1, 'manifest.json')),
        'checkpoints are kept'
      );

      // Next sweep: the capture succeeds, its archive copy is confirmed, then retire proceeds.
      await retireCodeSession(held);
      const retired = await prisma.codeSession.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(retired.state, 'RETIRED');
      assert.ok(retired.latestCheckpointSeq > 1, 'retire took one more checkpoint');
      assert.ok(!existsSync(home), 'the sandbox HOME is removed only after the capture');
      const last = await assertArchivedCheckpoint(agentId, created.id, retired.latestCheckpointSeq);
      assert.equal(last.cliFilesDeferred, undefined, 'nothing left deferred');
      const captured = (last.cliFiles ?? []).find((file) => file.path === deferredPath);
      assert.ok(captured, 'the deferred file is in the retire checkpoint');
      const body = await archived(
        agentId,
        codeCheckpointArchivePath(created.id, captured.seq, captured.artifact)
      );
      assert.equal(body?.toString('utf8'), deferredBody, 'its bytes are in the root bundle');
      await assertArchivedCheckpoint(agentId, created.id, 1);
    });
  });

  test('the TTL sweep pages past sessions whose retirement keeps failing, then retries them', async () => {
    await withUser(async (userId) => {
      const day = 24 * 60 * 60 * 1000;
      const sessions = [];
      for (const ageDays of [30, 29, 20]) {
        const agentId = randomUUID();
        const home = join(ctx.fixtureDir, `home-sweep-${randomUUID()}`);
        ctx.seedWorkspace(home);
        const session = await newSession(userId, agentId);
        await save(session.id, home, agentId);
        await prisma.codeSession.update({
          where: { id: session.id },
          data: { lastActiveAt: new Date(Date.now() - ageDays * day) },
        });
        sessions.push(session);
      }
      await waitForCodeSessionArchiveJobs();
      // The two oldest cannot be deleted (a transient storage failure).
      const blocked = sessions
        .slice(0, 2)
        .map((session) =>
          join(
            process.env.CODE_SESSION_STORAGE_LOCAL_DIR ?? '',
            checkpointKey(userId, session.id, 1, 'worktree.tar.gz')
          )
        );
      for (const path of blocked) {
        rmSync(path);
        write(join(path, 'blocker'), 'x');
      }
      const stateOf = async (id: string) =>
        (await prisma.codeSession.findUniqueOrThrow({ where: { id } })).state;
      const sweep = createExpiredCodeSessionSweeper(userId);
      try {
        assert.equal(await sweep(2), 0, 'the two oldest keep failing');
        assert.equal(await sweep(2), 1, 'the next pass reaches the session behind them');
        assert.equal(await stateOf(sessions[2].id), 'RETIRED');
        assert.notEqual(await stateOf(sessions[0].id), 'RETIRED');
      } finally {
        for (const path of blocked) rmSync(path, { recursive: true, force: true });
      }
      // The failures are retried on the wrap-around once storage recovers.
      for (const path of blocked) write(path, 'restored artifact');
      assert.equal(await sweep(2), 2);
      for (const session of sessions) assert.equal(await stateOf(session.id), 'RETIRED');
    });
  });

  test('the checkpoint backfill scans every allocated seq, even far above the committed one', () => {
    // Prod: latestCheckpointSeq 4, nextCheckpointSeq 23 (allocated, never committed).
    const gap = { latestCheckpointSeq: 4, nextCheckpointSeq: 23 };
    assert.deepEqual(
      checkpointSeqsToScan(gap),
      Array.from({ length: 23 }, (_, index) => 23 - index)
    );
    const capped = checkpointSeqsToScan(gap, 12);
    for (const seq of [23, 11, 4, 3, 2, 1]) assert.ok(capped.includes(seq), `seq ${seq} scanned`);
    assert.deepEqual(
      checkpointSeqsToScan({ latestCheckpointSeq: 40, nextCheckpointSeq: 40 }, 12),
      [40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28]
    );
  });
}
