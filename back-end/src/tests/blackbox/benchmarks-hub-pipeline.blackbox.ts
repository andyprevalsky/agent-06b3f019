#!/usr/bin/env tsx
/**
 * PIPELINE black-box for the Benchmark Hub dispatch flow — the core-infra
 * guarantee that a run dispatched from the app NEVER sits silently stuck.
 *
 * This is an end-to-end test of the REAL moving parts, not mocks:
 *   UI-equivalent dispatch (POST /run-requests, admin path)
 *     → placeholder run dashboard linked at creation (invariant)
 *     → the ACTUAL scripts/run-bench-hub-poller binary (child process) claims it
 *     → live snapshot lands (with code provenance + cost block)
 *     → final bundle uploaded → request completed → run verdict recorded
 * The only substitution is RUN_BENCH_BIN: a stub runner that emits the same
 * artifact layout (report-card.json + runs/*.json) in seconds instead of
 * booting a full stack. The poller, backend, store, and DB are all real.
 *
 * Every stage has a HARD deadline — a hang at any stage fails loudly with the
 * stage name, which is exactly the "stuck queued" class of regression.
 *
 * Legs:
 *   1. happy path: queued → claimed(<25s) → live snapshot(<40s) → completed,
 *      run passed, code + cost present, elapsed recorded
 *   2. failure honesty: stub exits nonzero → request failed + error text +
 *      the linked run dashboard shows failed tasks (never silent)
 *   3. no-poller detection: a dispatched request with no poller stays queued
 *      but its placeholder dashboard EXISTS and says so (the UI's timeline
 *      source of truth) — then a late poller still picks it up
 */

import { spawn, type ChildProcess } from 'child_process';
import http from 'http';
import { retryWithBackoff } from '../../providers/retry';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from 'dotenv';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const USER_ID = process.env.TEST_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const POLLER = path.join(REPO_ROOT, 'scripts', 'run-bench-hub-poller');
// Private claim scope: the stack's default poller (unscoped) never touches
// these requests, and our stub pollers never touch real user dispatches.
const SCOPE = `pipeline-test-${process.pid}-${Date.now()}`;

const headers = {
  'X-API-Key': API_KEY,
  'X-User-Id': USER_ID,
  'Content-Type': 'application/json',
};

interface StepResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function api(
  method: string,
  pathname: string,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

/** Dispatch a run request exactly like the UI (scoped so pollers don't cross-claim). */
async function dispatchRequest(taskNames: string[]): Promise<RequestRow> {
  const created = await api('POST', '/api/benchmarks/run-requests', {
    task_names: taskNames,
    scope: SCOPE,
  });
  assert(created.status === 201, `dispatch failed: ${created.status}`);
  return (created.data as { request: RequestRow }).request;
}

/** Wait until the request row reaches `status` (returns the row; throws with `stage` on timeout). */
function awaitStatus(
  id: string,
  stage: string,
  deadlineMs: number,
  status: string
): Promise<RequestRow> {
  return within(stage, deadlineMs, async () => {
    const row = await getRequest(id);
    return row.status === status ? row : null;
  });
}

/**
 * Wait for `check` to return a truthy value within `deadlineMs`, polling on a
 * short test-only interval via the canonical retry provider. Coverage is the
 * sole deploy execution of this domain, so it must enforce production's same
 * anti-stuck deadlines even while the implementation is instrumented.
 */
const TIMEOUT_SCALE = 1;
const PIPELINE_POLL_MS = 100;

async function within<T>(
  stage: string,
  deadlineMs: number,
  check: () => Promise<T | null | false>
): Promise<T> {
  const scaledDeadlineMs = deadlineMs * TIMEOUT_SCALE;
  const attempts = Math.max(2, Math.ceil(scaledDeadlineMs / PIPELINE_POLL_MS));
  try {
    return await retryWithBackoff(
      async () => {
        const value = await check();
        if (value === null || value === false || value === undefined) {
          throw new Error('not ready');
        }
        return value as T;
      },
      {
        maxRetries: attempts,
        fixedDelays: Array.from({ length: attempts }, () => PIPELINE_POLL_MS),
        isRetryable: () => true,
        component: `pipeline:${stage}`,
      }
    );
  } catch {
    throw new Error(`STUCK at stage "${stage}" — no progress within ${scaledDeadlineMs / 1000}s`);
  }
}

// ── stub runner: real artifact layout, seconds not minutes ──────────────────

function writeStubRunner(dir: string, mode: 'pass' | 'fail' | 'capacity-busy-then-pass'): string {
  const stub = path.join(dir, 'stub-run-bench');
  const script = `#!/usr/bin/env bash
# Stub runner for the pipeline blackbox — emits the REAL artifact layout the
# poller discovers (report-card.json + run.json in the request-owned context),
# then exits.
set -euo pipefail
${
  mode === 'capacity-busy-then-pass'
    ? `ATTEMPT_FILE="\${HUB_PIPELINE_BUSY_ATTEMPT_FILE:?}"
ATTEMPT="$(cat "$ATTEMPT_FILE" 2>/dev/null || echo 0)"
ATTEMPT=$((ATTEMPT + 1))
printf '%s\\n' "$ATTEMPT" > "$ATTEMPT_FILE"
if [ "$ATTEMPT" -eq 1 ]; then
  echo "CLOUDBENCH_RETRYABLE_CAPACITY=lease_busy" >&2
  echo "Cloud benchmark app is leased by another controller (HTTP 409); waiting is safe." >&2
  exit 75
fi`
    : ''
}
shift || true  # --local
TASK="\${1:-chat-mode}"
STAMP="stub-$(date +%s)-$$"
ARTIFACT_ROOT="\${BENCHMARK_CONTEXT_DIR:-agents/.context/benchmarks}"
CARD_DIR="$ARTIFACT_ROOT"
mkdir -p "$CARD_DIR"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$CARD_DIR/report-card.json" <<CARD
{"run_id":"$STAMP","timestamp":"$NOW","elapsed_s":7.5,
 "cost":{"agents_llm_usd":0.02,"wmh_grounding_usd":0.0,"infra_usd":0.01,"total_usd":0.03,"fast_cache_hit_rate":97},
 "metadata":{"tokens_in":1200,"tokens_out":300},
 "per_task":[{"name":"$TASK","status":"running","duration_s":null,"cost_usd":null,
   "agent_url":"http://localhost/?agent-id=stub-agent-1","world_model_mode":"real","fast_mode":true}]}
CARD
sleep 0.6  # long enough for the injected 0.1s snapshot cadence to observe "running"
${
  mode === 'fail'
    ? `echo "stub runner exploding on purpose" >&2
exit 1`
    : `cat > "$CARD_DIR/report-card.json" <<CARD
{"run_id":"$STAMP","timestamp":"$NOW","elapsed_s":19.0,
 "cost":{"agents_llm_usd":0.02,"wmh_grounding_usd":0.0,"infra_usd":0.01,"total_usd":0.03,"fast_cache_hit_rate":97},
 "metadata":{"tokens_in":1200,"tokens_out":300},
 "per_task":[{"name":"$TASK","status":"passed","duration_s":18.0,"cost_usd":0.03,
   "agent_url":"http://localhost/?agent-id=stub-agent-1","world_model_mode":"real","fast_mode":true}]}
CARD
cat > "$ARTIFACT_ROOT/run.json" <<RUN
{"run_id":"$STAMP","timestamp":"$NOW","suite":"stub",
 "tasks":[{"name":"$TASK","passed":true,"status":"COMPLETED","agent_id":"stub-agent-1",
   "duration_seconds":18.0,"cost_cents":3,"tokens_in":1200,"tokens_out":300,
   "fast_mode_cache_enabled":true,"world_model_mode":"real","tree_agent_count":1,
   "logs":{"messages":[{"role":"USER","message":"stub goal","created_at":"$NOW"},
                        {"role":"ASSISTANT","message":"stub result","created_at":"$NOW"}]}}]}
RUN
exit 0`
}
`;
  fs.writeFileSync(stub, script, { mode: 0o755 });
  return stub;
}

function writeForeignArtifactRunner(dir: string): {
  stub: string;
  cardDir: string;
  runFile: string;
} {
  const foreignId = `foreign-${process.pid}-${Date.now()}`;
  const cardDir = path.join(REPO_ROOT, 'agents', '.context', 'benchmarks', foreignId);
  const runFile = path.join(REPO_ROOT, 'agents', 'benchmarks', 'runs', `${foreignId}.json`);
  const stub = path.join(dir, 'stub-run-bench-foreign');
  const script = `#!/usr/bin/env bash
set -euo pipefail
shift || true
TASK="\${1:-chat-mode}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "${cardDir}" "$(dirname "${runFile}")"
cat > "${cardDir}/report-card.json" <<CARD
{"run_id":"${foreignId}","timestamp":"$NOW","elapsed_s":1,
 "per_task":[{"name":"$TASK","status":"passed"}]}
CARD
cat > "${runFile}" <<RUN
{"run_id":"${foreignId}","timestamp":"$NOW","suite":"foreign",
 "tasks":[{"name":"$TASK","passed":true,"status":"COMPLETED"}]}
RUN
echo "foreign artifact emitted; owned runner failed" >&2
exit 7
`;
  fs.writeFileSync(stub, script, { mode: 0o755 });
  return { stub, cardDir, runFile };
}

function startPoller(
  stubPath: string,
  log: string,
  hubUrl: string = BASE_URL,
  continuous = false,
  extraEnv: NodeJS.ProcessEnv = {}
): ChildProcess {
  // Spawn Bash directly instead of relying on the script's env/bash shebang.
  // Signalling a shebang wrapper can leave its real poller child orphaned.
  const child = spawn('bash', [POLLER, ...(continuous ? ['--local'] : ['--local', '--once'])], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HUB_URL: hubUrl,
      BACKEND_API_KEY: API_KEY,
      RUN_BENCH_BIN: stubPath,
      POLL_INTERVAL: '1',
      HUB_CAPACITY_RETRY_SECONDS: '1',
      HUB_SNAPSHOT_INTERVAL_SECONDS: '0.1',
      HUB_CLAIM_SCOPE: SCOPE,
      // Catalog export is production behavior, not part of this pipeline
      // contract. Keep the black-box hermetic so it cannot rewrite source.
      HUB_SKIP_CATALOG_EXPORT: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = fs.createWriteStream(log);
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  return child;
}

async function stopPoller(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      resolve();
    };
    child.once('exit', finish);
    const forceKill = setTimeout(() => {
      child.kill('SIGKILL');
    }, 2_000);
    forceKill.unref();
    if (!child.kill('SIGTERM')) finish();
  });
}

interface RequestRow {
  id: string;
  status: string;
  runId: string | null;
  claimedBy: string | null;
  error: string | null;
}

async function getRequest(id: string): Promise<RequestRow> {
  const res = await api('GET', '/api/benchmarks/run-requests');
  const rows = (res.data as { requests: RequestRow[] }).requests;
  const row = rows.find((r) => r.id === id);
  assert(row !== undefined, `request ${id} vanished from the queue view`);
  return row!;
}

interface RunDetail {
  live: boolean;
  code: string | null;
  elapsed_s: number | null;
  cost: { total_usd: number | null } | null;
  tasks: Array<{ name: string; status: string; failure_reason: string | null }>;
  dispatch: { status: string; claimed_by: string | null } | null;
}

async function getRun(runId: string): Promise<RunDetail | null> {
  const res = await api('GET', `/api/benchmarks/runs/${runId}`);
  if (res.status === 404) return null;
  assert(res.status === 200, `run detail ${res.status}`);
  return (res.data as { run: RunDetail }).run;
}

async function cleanup(requestRunId: string | null): Promise<void> {
  if (requestRunId !== null) {
    await api('DELETE', `/api/benchmarks/runs/${requestRunId}`).catch(() => undefined);
  }
}

// ── legs ─────────────────────────────────────────────────────────────────────

async function legHappyPath(tmp: string): Promise<void> {
  const stub = writeStubRunner(tmp, 'pass');
  let runId: string | null = null;
  let poller: ChildProcess | null = null;
  try {
    // dispatch exactly like the UI
    const request = await dispatchRequest(['chat-mode']);
    runId = request.runId;

    // INVARIANT: the run dashboard exists + is linked from second zero
    assert(request.runId === `hub-${request.id}`, 'dispatch not linked to a run');
    const placeholder = await getRun(request.runId!);
    assert(placeholder !== null, 'placeholder run dashboard missing at dispatch');
    assert(
      placeholder!.live && placeholder!.tasks[0].status === 'queued',
      'placeholder not queued'
    );
    assert(placeholder!.dispatch?.status === 'queued', 'dispatch lifecycle missing on run view');

    // the REAL poller claims it fast
    poller = startPoller(stub, path.join(tmp, 'poller-happy.log'));
    const claimed = await awaitStatus(request.id, 'claimed by poller', 25_000, 'running');
    assert(claimed.claimedBy !== null, 'poller claimed the request but recorded no claimedBy');

    // live snapshot arrives with the dashboard essence: code + cost + running task
    await within('live snapshot with code+cost', 45_000, async () => {
      const run = await getRun(request.runId!);
      return run !== null &&
        run.code !== null &&
        run.cost !== null &&
        run.tasks[0].status !== 'queued'
        ? run
        : null;
    });

    // completes: request completed, run final + passed + elapsed recorded
    await awaitStatus(request.id, 'request completed', 60_000, 'completed');
    const final = await within('final bundle recorded', 20_000, async () => {
      const run = await getRun(request.runId!);
      return run !== null && !run.live && run.tasks[0].status === 'passed' ? run : null;
    });
    assert(final.elapsed_s !== null, 'final run missing elapsed');
    assert(final.cost?.total_usd !== null, 'final run missing cost breakdown');

    // A snapshot request that was already in flight when the poller finalized
    // must not regress the completed bundle back to live/running.
    const lateSnapshot = await api('POST', '/api/benchmarks/runs?live=1', {
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      suite: 'hub-dispatch',
      source: 'pipeline-test-late-snapshot',
      tasks: [{ name: 'chat-mode', status: 'running', passed: null }],
    });
    assert(lateSnapshot.status === 201, `late snapshot returned ${lateSnapshot.status}`);
    const afterLateSnapshot = await getRun(request.runId!);
    assert(
      afterLateSnapshot !== null &&
        !afterLateSnapshot.live &&
        afterLateSnapshot.tasks[0].status === 'passed',
      'late snapshot regressed a finalized run'
    );
  } finally {
    await stopPoller(poller);
    await cleanup(runId);
  }
}

async function legFailureHonesty(tmp: string): Promise<void> {
  const stub = writeStubRunner(tmp, 'fail');
  let runId: string | null = null;
  let poller: ChildProcess | null = null;
  try {
    const request = await dispatchRequest(['chat-mode']);
    runId = request.runId;

    poller = startPoller(stub, path.join(tmp, 'poller-fail.log'));
    const failed = await awaitStatus(request.id, 'request marked failed', 90_000, 'failed');
    assert(failed.error !== null && failed.error !== '', 'failure has no error text');

    // the linked dashboard reflects the failure — never a silent zombie
    const run = await within('run dashboard shows failure', 20_000, async () => {
      const r = await getRun(request.runId!);
      return r !== null && !r.live && r.tasks.some((t) => t.status === 'failed') ? r : null;
    });
    assert(
      run.tasks.some((t) => t.failure_reason !== null && t.failure_reason !== ''),
      'failed task missing failure_reason'
    );
  } finally {
    await stopPoller(poller);
    await cleanup(runId);
  }
}

async function legCapacityBusyWaitsAndRetries(tmp: string): Promise<void> {
  const stub = writeStubRunner(tmp, 'capacity-busy-then-pass');
  const attemptFile = path.join(tmp, 'capacity-busy-attempts');
  let runId: string | null = null;
  let poller: ChildProcess | null = null;
  try {
    const request = await dispatchRequest(['chat-mode']);
    runId = request.runId;

    poller = startPoller(stub, path.join(tmp, 'poller-capacity-busy.log'), BASE_URL, false, {
      HUB_CAPACITY_RETRY_SECONDS: '1',
      HUB_PIPELINE_BUSY_ATTEMPT_FILE: attemptFile,
    });

    await within('capacity-busy result observed', 25_000, async () => {
      if (!fs.existsSync(attemptFile)) return null;
      return fs.readFileSync(attemptFile, 'utf8').trim() === '1' ? true : null;
    });
    const waiting = await getRequest(request.id);
    assert(
      waiting.status === 'running' && waiting.error === null,
      'FAIL: retryable lease contention became a terminal failed dispatch'
    );

    const completed = await awaitStatus(
      request.id,
      'capacity retry completed',
      60_000,
      'completed'
    );
    assert(completed.error === null, 'capacity retry left a terminal error on the request');
    assert(
      fs.readFileSync(attemptFile, 'utf8').trim() === '2',
      'capacity runner was not retried once'
    );

    const final = await getRun(request.runId!);
    assert(
      final !== null && !final.live && final.tasks[0].status === 'passed',
      'capacity retry did not preserve the successful final bundle'
    );
  } finally {
    await stopPoller(poller);
    await cleanup(runId);
  }
}

async function legLatePollerPickup(tmp: string): Promise<void> {
  const stub = writeStubRunner(tmp, 'pass');
  let runId: string | null = null;
  let poller: ChildProcess | null = null;
  try {
    const request = await dispatchRequest(['chat-mode']);
    runId = request.runId;

    // with NO poller: the request stays queued but the dashboard exists and
    // says exactly that (what the UI timeline renders) — visible, not silent
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const still = await getRequest(request.id);
    assert(still.status === 'queued', 'request should still be queued without a poller');
    const dash = await getRun(request.runId!);
    assert(
      dash !== null && dash.dispatch?.status === 'queued',
      'queued state not visible on dashboard'
    );

    // a poller arriving late still executes it
    poller = startPoller(stub, path.join(tmp, 'poller-late.log'));
    await awaitStatus(request.id, 'late poller completes the run', 90_000, 'completed');
  } finally {
    await stopPoller(poller);
    await cleanup(runId);
  }
}

async function legForeignArtifactIsolation(tmp: string): Promise<void> {
  const foreign = writeForeignArtifactRunner(tmp);
  let runId: string | null = null;
  let poller: ChildProcess | null = null;
  const log = path.join(tmp, 'poller-foreign.log');
  try {
    const request = await dispatchRequest(['chat-mode']);
    runId = request.runId;

    poller = startPoller(foreign.stub, log);
    const failed = await awaitStatus(request.id, 'foreign artifact rejected', 30_000, 'failed');
    assert(
      failed.error?.includes('no run bundle produced (exit 7)') === true,
      `foreign artifact was not rejected honestly: ${failed.error}`
    );
    const pollerLog = fs.readFileSync(log, 'utf8');
    assert(
      pollerLog.includes('no run bundle found after exit=7'),
      'poller did not report the missing request-owned bundle'
    );
    assert(!pollerLog.includes('uploading final bundle'), 'poller uploaded a foreign run bundle');
  } finally {
    await stopPoller(poller);
    fs.rmSync(foreign.cardDir, { recursive: true, force: true });
    fs.rmSync(foreign.runFile, { force: true });
    await cleanup(runId);
  }
}

async function legSnapshotStopsBeforeTerminal(tmp: string): Promise<void> {
  const stub = writeStubRunner(tmp, 'pass');
  const pollerLog = path.join(tmp, 'poller-snapshot-teardown.log');
  let runId: string | null = null;
  let poller: ChildProcess | null = null;
  let snapshotStarted = false;
  let terminalSeen = false;
  let staleProgressAfterTerminal = false;
  const heldSnapshotResponses = new Set<http.ServerResponse>();

  const releaseHeldSnapshots = (): void => {
    for (const response of heldSnapshotResponses) {
      heldSnapshotResponses.delete(response);
      if (response.destroyed) continue;
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end('{}');
    }
  };

  // Hold the live-snapshot response until after the runner exits. A leaked
  // uploader will then send its progress PATCH after the terminal PATCH; a
  // correctly reaped uploader disappears before the held response is released.
  const proxy = http.createServer((req, res) => {
    const requestPath = req.url ?? '';
    const forward = (body?: Buffer): void => {
      const upstreamHeaders = { ...req.headers };
      if (body !== undefined) upstreamHeaders['content-length'] = String(body.length);
      const upstream = http.request(
        `${BASE_URL}${requestPath}`,
        { method: req.method, headers: upstreamHeaders },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        }
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      if (body === undefined) req.pipe(upstream);
      else upstream.end(body);
    };

    if (req.method === 'POST' && requestPath.startsWith('/api/benchmarks/runs?live=1')) {
      snapshotStarted = true;
      req.resume();
      heldSnapshotResponses.add(res);
      return;
    }

    if (req.method === 'PATCH' && requestPath.includes('/api/benchmarks/run-requests/')) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        try {
          const action = (JSON.parse(body.toString()) as { action?: string }).action;
          if (action === 'complete' || action === 'fail') terminalSeen = true;
          if (action === 'progress' && terminalSeen) staleProgressAfterTerminal = true;
        } catch {
          // The backend remains authoritative for malformed-request handling.
        }
        forward(body);
      });
      return;
    }

    forward();
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  const proxyUrl = `http://127.0.0.1:${
    typeof address === 'object' && address !== null ? address.port : 0
  }`;

  try {
    const request = await dispatchRequest(['chat-mode']);
    runId = request.runId;

    poller = startPoller(stub, pollerLog, proxyUrl);
    await within('snapshot upload enters proxy', 30_000, async () => snapshotStarted || null);
    await awaitStatus(request.id, 'completes after snapshot cancel', 60_000, 'completed');
    assert(terminalSeen, 'terminal completion PATCH never reached the hub');
    // Release the exact blocked request immediately instead of waiting for a
    // seven-second timer. The original contract observed one further second:
    // a leaked uploader resumes and sends its forbidden progress PATCH, while
    // a correctly reaped uploader has already closed the socket.
    releaseHeldSnapshots();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert(
      !staleProgressAfterTerminal,
      'snapshot uploader survived completion and sent stale progress after the terminal PATCH'
    );
  } catch (error) {
    const details = fs.existsSync(pollerLog)
      ? fs.readFileSync(pollerLog, 'utf8')
      : '(no poller log)';
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\npoller log:\n${details}`
    );
  } finally {
    releaseHeldSnapshots();
    await stopPoller(poller);
    proxy.close();
    await cleanup(runId);
  }
}

async function legHubOutageSpool(tmp: string): Promise<void> {
  // Simulate the hub dying mid-run (the exact incident class: backend down at
  // completion time). The poller must survive, spool the completion, and a
  // later poller tick must flush it — the request NEVER strands as 'running'.
  const stub = writeStubRunner(tmp, 'pass');
  let runId: string | null = null;
  let poller: ChildProcess | null = null;
  let flusher: ChildProcess | null = null;

  // pass-through proxy we can kill
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(
      `${BASE_URL}${req.url ?? ''}`,
      { method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  const proxyUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;

  // Isolate this poller's recovery queue from any developer poller already
  // running in the same worktree. Otherwise that healthy poller can consume
  // the outage record before this leg observes it.
  const spoolEnv = { HUB_UPLOAD_SPOOL_DIR: path.join(tmp, 'hub-upload-spool') };
  try {
    const request = await dispatchRequest(['chat-mode']);
    runId = request.runId;

    // This leg exercises the production poller's long-running recovery mode.
    // A one-shot poller intentionally exits after one empty/transient queue
    // read, which can make the proxy setup—not outage recovery—the assertion.
    poller = startPoller(stub, path.join(tmp, 'poller-outage.log'), proxyUrl, true, spoolEnv);
    await awaitStatus(request.id, 'claimed (via proxy)', 25_000, 'running');

    // OUTAGE: kill the hub from the poller's perspective mid-run
    await new Promise<void>((resolve) => proxy.close(() => resolve()));

    // the poller must SURVIVE and spool the completion
    const spoolFile = path.join(spoolEnv.HUB_UPLOAD_SPOOL_DIR, `${request.id}.json`);
    await within('completion spooled during outage', 60_000, async () =>
      fs.existsSync(spoolFile) ? true : null
    );
    const midOutage = await getRequest(request.id);
    assert(midOutage.status === 'running', 'request should still be running while spooled');

    // hub is back (BASE_URL was healthy all along) — a fresh poller tick flushes
    flusher = startPoller(stub, path.join(tmp, 'poller-flush.log'), BASE_URL, false, spoolEnv);
    await awaitStatus(request.id, 'spool flushed after recovery', 40_000, 'completed');
    // The Hub row becomes completed immediately before the poller unlinks the
    // durable spool file. Observe both effects instead of racing that cleanup.
    await within('spool file removed after flush', 5_000, async () =>
      !fs.existsSync(spoolFile) ? true : null
    );
  } finally {
    await stopPoller(poller);
    await stopPoller(flusher);
    proxy.close();
    await cleanup(runId);
  }
}

async function legProductionDefaultsRemainPinned(): Promise<void> {
  const pollerSource = fs.readFileSync(POLLER, 'utf8');
  assert(
    pollerSource.includes('POLL_INTERVAL="${POLL_INTERVAL:-10}"'),
    'production poll interval default must remain 10 seconds'
  );
  assert(
    pollerSource.includes('HUB_SNAPSHOT_INTERVAL_SECONDS="${HUB_SNAPSHOT_INTERVAL_SECONDS:-15}"'),
    'production live-snapshot interval default must remain 15 seconds'
  );
  assert(
    pollerSource.includes(
      'HUB_UPLOAD_SPOOL_DIR="${HUB_UPLOAD_SPOOL_DIR:-.context/hub-upload-spool}"'
    ),
    'production recovery spool must retain its repo-local default'
  );
}

// ── runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('BACKEND_API_KEY required');
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pipeline-'));
  const legs: Array<[string, (tmp: string) => Promise<void>]> = [
    ['production poll and snapshot defaults remain pinned', legProductionDefaultsRemainPinned],
    ['happy path: dispatch → claim → live → completed (hard deadlines)', legHappyPath],
    ['failure honesty: generic exit 1 → failed + error + dashboard reflects', legFailureHonesty],
    [
      'capacity busy: claimed request waits, retries, then completes',
      legCapacityBusyWaitsAndRetries,
    ],
    ['late poller: queued is visible, then still picked up', legLatePollerPickup],
    ['artifact isolation: newer foreign bundle is rejected', legForeignArtifactIsolation],
    ['snapshot uploader is reaped before terminal completion', legSnapshotStopsBeforeTerminal],
    ['hub outage at completion: poller survives, spools, flushes on recovery', legHubOutageSpool],
  ];
  const results: StepResult[] = [];
  for (const [name, fn] of legs) {
    const start = Date.now();
    try {
      await fn(tmp);
      results.push({ name, passed: true, duration: Date.now() - start });
    } catch (error) {
      results.push({
        name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - start,
      });
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\nBenchmark Hub PIPELINE black-box\n${'='.repeat(60)}`);
  for (const r of results) {
    console.log(
      `${r.passed ? '  PASS' : '  FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${Math.round(r.duration / 1000)}s)`
    );
  }
  const failed = results.filter((r) => !r.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('pipeline suite crashed:', error);
  process.exit(1);
});
