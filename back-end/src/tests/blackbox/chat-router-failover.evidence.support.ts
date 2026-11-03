/** Opt-in live-test evidence capture; no router, provider, or timing changes. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { PrismaClient } from '@prisma/client';
import type { LiveSample } from './chat-router-failover.live.support';
import type { SearchRequest } from './chat-router-failover.network.support';

const execFileAsync = promisify(execFile);
const ROOT = resolve(__dirname, '../../../..');
const FIXTURE = 'back-end/src/tests/fixtures/chat-router-failover-prod-e8f2279b.json';
const SOURCES = [
  'back-end/src/providers/chat/routerDecisionJsonSchema.ts',
  'back-end/src/providers/chat/routerDecision.ts',
  'back-end/src/providers/chat/routerJsonStream.ts',
  'back-end/src/providers/chat/routerLlm.ts',
  'back-end/src/providers/chat/chatPrompts.ts',
  'back-end/src/providers/rose/openrouterFastRoute.ts',
  'back-end/src/tests/blackbox/chat-router-failover.blackbox.ts',
  'back-end/src/tests/blackbox/chat-router-failover.evidence.support.ts',
  'back-end/src/tests/blackbox/chat-router-failover.network.support.ts',
  'back-end/src/tests/blackbox/chat-router-failover.live.support.ts',
] as const;
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export interface LiveEvidenceCapture {
  runId: string;
  dir: string;
  startedAt: string;
  label: string;
  gitSha: string;
  sourceSha256: Record<string, string>;
  fixtureSha256: string;
  sample?: unknown;
}

export interface LiveSeededAgent {
  userId: string;
  agentId: string;
  evidence?: LiveEvidenceCapture;
}

interface LiveEvidenceSampleSource {
  outcome: LiveSample['outcome'];
  network: {
    decisionRounds(): LiveSample['rounds'];
    searchRequests: readonly SearchRequest[];
    alerts: LiveSample['alerts'];
  };
  goal?: string;
}

/** What the network boundary did with the turn's web searches (chat-router-failover.network.support.ts). */
const SEARCH_BOUNDARY =
  'Parallel search POSTs were answered in-process with 200 {"results":[]}; ' +
  'this probe tests routing failover, not search.';

export function recordLiveEvidenceSample(
  capture: LiveEvidenceCapture | undefined,
  { outcome, network, goal }: LiveEvidenceSampleSource
): void {
  if (capture) {
    const rounds = network.decisionRounds();
    const outcomeRound = rounds.at(-1);
    capture.sample = {
      outcome,
      attempts: outcomeRound?.attempts ?? 0,
      glm: outcomeRound?.glm ?? [],
      rounds,
      searchRequests: network.searchRequests,
      searchBoundary: SEARCH_BOUNDARY,
      alerts: network.alerts,
      goal,
    };
  }
}

export async function cleanupLiveEvidence(
  db: Pick<PrismaClient, 'agent' | 'browserSession' | 'toolUsage' | 'user'>,
  seeded: LiveSeededAgent
): Promise<void> {
  await withEvidenceCleanup(
    async () => {
      if (seeded.evidence) {
        const runJson = await captureLiveEvidence(db, seeded.agentId, seeded.evidence);
        await publishCapturedLiveEvidence(runJson);
        process.stdout.write(`  captured live evidence before cleanup: ${runJson}\n`);
      }
    },
    async () => {
      await db.toolUsage.deleteMany({ where: { agentId: seeded.agentId } });
      await db.agent.deleteMany({ where: { id: seeded.agentId } });
      await db.user.deleteMany({ where: { userId: seeded.userId } });
    }
  );
}

/** Evidence/cleanup errors must not replace the original gate or request failure. */
export async function withEvidenceCleanup<T>(
  task: () => Promise<T>,
  cleanup: () => Promise<void>,
  checkResultOnCleanupFailure?: (result: T) => void
): Promise<T> {
  let result!: T;
  let taskFailed = false;
  let taskError: unknown;
  try {
    result = await task();
  } catch (error) {
    taskFailed = true;
    taskError = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (!taskFailed && checkResultOnCleanupFailure) {
      try {
        checkResultOnCleanupFailure(result);
      } catch (error) {
        taskFailed = true;
        taskError = error;
      }
    }
    if (taskFailed) {
      throw new AggregateError(
        [taskError, cleanupError],
        `Live gate/request failed: ${String(taskError)}; evidence/cleanup also failed: ${String(cleanupError)}`,
        { cause: taskError }
      );
    }
    throw cleanupError;
  }
  if (taskFailed) throw taskError;
  return result;
}

export function assertLiveSampleHasNoSecrets(
  sample: unknown,
  env: NodeJS.ProcessEnv = process.env
): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (
        /^(?:authorization|proxy[-_]authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)$/i.test(
          key
        )
      ) {
        throw new Error('live evidence contains a credential/header field; publication refused');
      }
      visit(nested);
    }
  };
  visit(sample);
  const serialized = JSON.stringify(sample) ?? '';
  for (const [name, value] of Object.entries(env)) {
    if (
      /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(name) &&
      value &&
      value.length >= 12 &&
      serialized.includes(value)
    ) {
      throw new Error('live evidence contains a configured credential value; publication refused');
    }
  }
}

/** Allocate a new real capture run before the fresh sample starts. */
export function beginLiveEvidenceCapture(label: string): LiveEvidenceCapture | undefined {
  const output = process.env.CHAT_ROUTER_FAILOVER_CAPTURE_DIR;
  if (!output) return undefined;
  const runId = randomUUID();
  const dir = join(resolve(output), runId);
  mkdirSync(dir, { recursive: true });
  const capture: LiveEvidenceCapture = {
    runId,
    dir,
    startedAt: new Date().toISOString(),
    label,
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    sourceSha256: Object.fromEntries(
      SOURCES.map((path) => [path, sha256(readFileSync(join(ROOT, path)))])
    ),
    fixtureSha256: sha256(readFileSync(join(ROOT, FIXTURE))),
  };
  writeFileSync(join(dir, 'capture-start.json'), JSON.stringify(capture, null, 2) + '\n', {
    flag: 'wx',
  });
  return capture;
}

/** Copy actual persisted rows while they exist; never infer children from old fixture text. */
export async function captureLiveEvidence(
  db: Pick<PrismaClient, 'agent' | 'browserSession'>,
  rootId: string,
  capture: LiveEvidenceCapture
): Promise<string> {
  const root = await db.agent.findUniqueOrThrow({ where: { id: rootId } });
  const rows = [];
  const seen = new Set<string>();
  let frontier = [rootId];
  while (frontier.length) {
    const agents = await db.agent.findMany({
      where: { id: { in: frontier }, userId: root.userId },
      include: {
        messages: { orderBy: [{ timestamp: 'asc' }, { id: 'asc' }] },
        toolUsages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
      orderBy: { id: 'asc' },
    });
    for (const agent of agents) {
      if (!seen.has(agent.id)) rows.push(agent);
      seen.add(agent.id);
    }
    const children = await db.agent.findMany({
      where: { parentAgentId: { in: agents.map((agent) => agent.id) }, userId: root.userId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    frontier = children.map((agent) => agent.id).filter((id) => !seen.has(id));
  }
  if (!seen.has(rootId)) throw new Error(`missing actual evidence root ${rootId}`);
  const sessions = await db.browserSession.findMany({
    where: { agentId: { in: [...seen] } },
    select: {
      id: true,
      agentId: true,
      sessionId: true,
      status: true,
      provider: true,
      createdAt: true,
      closedAt: true,
    },
    orderBy: { id: 'asc' },
  });
  const capturedAt = new Date().toISOString();
  const raw = JSON.stringify({ captured_at: capturedAt, agents: rows, browser_sessions: sessions });
  writeFileSync(join(capture.dir, 'actual-db-rows.json'), raw + '\n', { flag: 'wx' });
  const tree = Object.fromEntries(
    rows.map((agent) => [
      agent.id,
      {
        parent_agent_id: agent.parentAgentId,
        goal: agent.goal,
        status: agent.status,
        tokens_in: agent.tokensIn,
        tokens_out: agent.tokensOut,
        context_size: agent.contextSize,
        response_schema: agent.responseSchema,
        structured_output: agent.structuredResponse,
        messages: agent.messages.map((message) => ({
          message_id: message.id,
          role: message.role,
          message: message.text,
          created_at: message.timestamp.toISOString(),
          metadata: message.metadata,
          file_pointer: message.filePointer,
        })),
      },
    ])
  );
  const bundle = {
    run_id: capture.runId,
    timestamp: capture.startedAt,
    suite: 'blackbox',
    source: 'chat-router-failover-live-evidence',
    evidence_capture: {
      ...capture,
      captured_at: capturedAt,
      actual_db_rows_sha256: sha256(raw + '\n'),
      fixture_path: FIXTURE,
      provenance:
        'Fresh live chat turn on an anonymous root seeded from the existing sanitized e8f2279b fixture. Prior seeded messages retain fixture content/metadata; they are not newly executed sub-agents or browser sessions. Temporal is the existing in-memory blackbox client.',
    },
    tasks: [
      {
        name: 'chat-router-failover-live',
        agent_id: rootId,
        passed: null,
        status: 'evidence-only',
        tree_agent_count: rows.length,
        fast_mode_cache_enabled: root.fastModeCacheEnabled,
        world_model_mode: root.worldModelMode,
        logs: {
          messages: tree[rootId].messages,
          tree,
          live_sample: capture.sample ?? null,
          browser_sessions: sessions,
        },
      },
    ],
  };
  const path = join(capture.dir, 'run.json');
  writeFileSync(path, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' });
  return path;
}

/** Existing publisher verifies the actual archived viewer and last call; no fallback or invented data. */
export async function publishCapturedLiveEvidence(runJson: string): Promise<void> {
  if (process.env.CHAT_ROUTER_FAILOVER_PUBLISH_EVIDENCE !== '1') return;
  const bundle = JSON.parse(readFileSync(runJson, 'utf8')) as {
    tasks: Array<{
      agent_id: string;
      logs: { tree: Record<string, unknown>; live_sample: unknown };
    }>;
  };
  const task = bundle.tasks[0];
  assertLiveSampleHasNoSecrets(task.logs.live_sample);
  const dumps = Object.keys(task.logs.tree).flatMap((id) => {
    const dir = join(ROOT, '.llm-dumps', id);
    try {
      return readdirSync(dir)
        .filter((name) => /^\d+-.*\.json$/.test(name))
        .map((name) => ({ path: join(dir, name), timestamp: Number(name.split('-')[0]) }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  });
  const last = dumps.sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!last) throw new Error(`no actual LLM call captured for ${task.agent_id}`);
  const dir = resolve(runJson, '..');
  const python = join(ROOT, 'agents/venv/bin/python');
  const bootstrap = [
    'import os,runpy,sys',
    'from dotenv import load_dotenv',
    // The isolated runner's local-only share signer cannot authenticate prod.
    // Read the existing configured publisher signer only in this child process.
    'os.environ.pop("BENCHMARK_SHARE_SECRET",None)',
    'load_dotenv("back-end/.env", override=False)',
    'load_dotenv("agents/.env", override=False)',
    'sys.argv=["scripts/publish_evidence_links.py"]+sys.argv[1:]',
    'runpy.run_path("scripts/publish_evidence_links.py",run_name="__main__")',
  ].join(';');
  try {
    const result = await execFileAsync(
      python,
      ['-c', bootstrap, '--run-json', runJson, '--agent-id', task.agent_id, '--dump', last.path],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          BENCHMARK_HUB_UPLOAD_URL: 'https://navi-j9a9.onrender.com',
          RCA_EVIDENCE_ARTIFACTS_ROOT: join(dir, 'published'),
        },
      }
    );
    writeFileSync(join(dir, 'publisher.log'), result.stdout + result.stderr);
    process.stdout.write(result.stdout);
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    writeFileSync(join(dir, 'publisher.log'), (failed.stdout ?? '') + (failed.stderr ?? ''));
    throw error;
  }
}
