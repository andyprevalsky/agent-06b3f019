/**
 * Trace archive of code inspections, run inside code-session-inspect.blackbox.ts
 * with a hermetic local trace archive (TRACE_ARCHIVE_BACKEND=local, temp dir):
 *
 *   inspectCodeSession (caller: a sub-agent) ──► caller tree root's bundle
 *     code/<session>/inspect-<id>/attempt-<n>/{stdout.jsonl, stderr.txt, exit-code.txt,
 *       instructions.txt, cli-<sha256> (transcripts + subagents the CLI wrote)}
 *     code/<session>/inspect-<id>/manifest.json (question, result, attempts) last
 *   C15 fall-over: both attempts archived (asserted from the C15 case); when the
 *   fall-over provider then fails to start, the usage-limited attempt is still
 *   archived with the terminal error before the inspection throws
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { prisma } from '../../providers/database';
import { waitForCodeSessionArchiveJobs } from '../../providers/codeSessions/archiveMirror';
import { inspectCodeSession } from '../../providers/codeSessions/inspect';
import { __resetAnthropicApiKeyCooldown } from '../../providers/computeCredentials';
import {
  decryptAndValidateArtifact,
  localObjectPath,
  readArchivedArtifactStrict,
} from '../../providers/traceArchive';

export interface InspectArchiveContext {
  fixtureDir: string;
  userA: string;
  agentA: string;
  setMode: (mode: string) => void;
  seedWorkspace: (home: string) => unknown;
  liveSession: (home: string) => Promise<{ id: string }>;
  /** Make every new sandbox of `provider` fail to start (null: none fail). */
  failSandboxFor: (provider: string | null) => void;
}

interface ArchivedInspection {
  question: string;
  agent_id: string;
  root_agent_id: string;
  checkpoint_seq: number;
  result: { answer: string | null; status: string; error?: string | null };
  attempts: Array<{
    provider: string;
    artifacts: Record<string, { sha256: string; size: number }>;
    cli_files: Array<{ path: string; sha256: string; artifact: string; restored?: boolean }>;
  }>;
}

const ARCHIVE_ENV = ['TRACE_ARCHIVE_BACKEND', 'TRACE_ARCHIVE_LOCAL_DIR', 'TRACE_ARCHIVE_ENABLED'];

/** Decrypted object of a root bundle (null when absent). */
async function archivedObject(rootAgentId: string, objectPath: string): Promise<Buffer | null> {
  const stored = await readArchivedArtifactStrict({ rootAgentId, objectPath });
  return stored === null ? null : decryptAndValidateArtifact(stored);
}

function inspectionDirs(rootAgentId: string, codeSessionId: string): string[] {
  const dir = localObjectPath(rootAgentId, `code/${codeSessionId}`);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('inspect-')) : [];
}

/** The one archived inspection of `codeSessionId` in `rootAgentId`'s bundle. */
export async function archivedInspection(
  rootAgentId: string,
  codeSessionId: string
): Promise<{ base: string; manifest: ArchivedInspection }> {
  const dirs = inspectionDirs(rootAgentId, codeSessionId);
  assert.equal(dirs.length, 1, 'one archived inspection');
  const base = `code/${codeSessionId}/${dirs[0]}`;
  const raw = await archivedObject(rootAgentId, `${base}/manifest.json`);
  assert.ok(raw, 'the inspection manifest is archived');
  return { base, manifest: JSON.parse(raw.toString('utf8')) as ArchivedInspection };
}

export function registerInspectArchiveCases(ctx: InspectArchiveContext): void {
  const saved = new Map(ARCHIVE_ENV.map((key) => [key, process.env[key]]));
  before(() => {
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = join(ctx.fixtureDir, 'trace-archive-root');
    process.env.TRACE_ARCHIVE_ENABLED = '1';
  });
  after(async () => {
    await waitForCodeSessionArchiveJobs();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("an inspection archives its CLI trajectory and answer into the caller's root bundle", async () => {
    ctx.setMode('answer');
    const liveHome = join(ctx.fixtureDir, 'live-home-archive');
    ctx.seedWorkspace(liveHome);
    const live = await ctx.liveSession(liveHome);
    // The caller is a sub-agent of agentA: its inspection belongs to agentA's tree.
    const caller = await prisma.agent.create({
      data: { userId: ctx.userA, goal: 'explore the code', parentAgentId: ctx.agentA, depth: 1 },
    });
    const question = 'What does feature.txt say? (archived)';
    try {
      const result = await inspectCodeSession({
        userId: ctx.userA,
        agentId: caller.id,
        codeSessionId: live.id,
        question,
      });
      assert.equal(result.status, 'answered', JSON.stringify(result));
      assert.deepEqual(inspectionDirs(caller.id, live.id), [], 'nothing in a non-root bundle');
      const { base, manifest } = await archivedInspection(ctx.agentA, live.id);
      assert.equal(manifest.question, question);
      assert.deepEqual([manifest.agent_id, manifest.root_agent_id], [caller.id, ctx.agentA]);
      assert.equal(manifest.result.answer, result.answer);
      assert.equal(manifest.checkpoint_seq, result.checkpoint_seq);
      assert.deepEqual(
        manifest.attempts.map((attempt) => attempt.provider),
        ['claude']
      );
      const [attempt] = manifest.attempts;
      for (const name of ['stdout.jsonl', 'stderr.txt', 'exit-code.txt', 'instructions.txt']) {
        const body = await archivedObject(ctx.agentA, `${base}/attempt-1/${name}`);
        assert.ok(body, `${name} archived`);
        assert.equal(attempt.artifacts[name]?.size, body.length, name);
      }
      const stdout = await archivedObject(ctx.agentA, `${base}/attempt-1/stdout.jsonl`);
      assert.match(stdout?.toString() ?? '', /"type": ?"result"/, 'the CLI event stream');
      const written = attempt.cli_files.filter((file) => !file.restored);
      const transcript = written.find((file) =>
        /^\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(file.path)
      );
      assert.ok(transcript, JSON.stringify(written));
      assert.ok(
        written.some((file) => file.path.endsWith('/subagents/agent-inspect.jsonl')),
        'subagent transcripts are archived too'
      );
      for (const file of written) {
        const body = await archivedObject(ctx.agentA, `${base}/attempt-1/${file.artifact}`);
        assert.ok(body, `${file.path} archived`);
        assert.equal(createHash('sha256').update(body).digest('hex'), file.sha256, file.path);
      }
      const body = await archivedObject(ctx.agentA, `${base}/attempt-1/${transcript.artifact}`);
      assert.ok(body?.toString().includes(question), 'the transcript holds the question');
    } finally {
      await prisma.agent.delete({ where: { id: caller.id } });
    }
  });

  test('a usage-limited Claude attempt stays archived when the Codex fall-over fails to start', async () => {
    const liveHome = join(ctx.fixtureDir, 'live-home-archive-failover');
    ctx.seedWorkspace(liveHome);
    const live = await ctx.liveSession(liveHome);
    await __resetAnthropicApiKeyCooldown();
    ctx.setMode('rate_limit');
    ctx.failSandboxFor('codex');
    try {
      await assert.rejects(
        inspectCodeSession({
          userId: ctx.userA,
          agentId: ctx.agentA,
          codeSessionId: live.id,
          question: 'What does feature.txt say? (fall-over fails)',
        }),
        /codex inspection sandbox failed to start/
      );
      const { base, manifest } = await archivedInspection(ctx.agentA, live.id);
      assert.deepEqual(
        manifest.attempts.map((attempt) => attempt.provider),
        ['claude'],
        'the completed Claude attempt is archived'
      );
      assert.equal(manifest.result.status, 'failed');
      assert.match(manifest.result.error ?? '', /codex inspection sandbox failed to start/);
      const stdout = await archivedObject(ctx.agentA, `${base}/attempt-1/stdout.jsonl`);
      assert.ok(stdout && stdout.length > 0, 'the Claude CLI stream is archived');
    } finally {
      ctx.failSandboxFor(null);
      await __resetAnthropicApiKeyCooldown();
    }
  });
}
