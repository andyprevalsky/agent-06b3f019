/**
 * Readiness wait for a sandbox's ws-server (Claude Code and Codex sessions).
 *
 * "Ready" means the server answers a request, not that its port is bound: a
 * server that binds first and then blocks its event loop (a synchronous clone,
 * a git fetch) looks listening to `netstat` while it can neither complete a
 * WebSocket handshake nor acknowledge a turn. Calling that ready sent the
 * agents activity into a 30 s connect timeout, a retry that closed the
 * "unreachable" task and created another, and made every message to the task
 * fail with "no user_turn_ack" (RCA 2026-11-06-ws-server-ready-while-clone-blocks-event-loop).
 *
 * One `curl` per poll, run inside the sandbox, tells four states apart:
 *
 *   curl rc 7  (refused)      ─▶ down      nothing is bound yet, or the server died
 *   curl rc 28 / 52 / 56      ─▶ starting  bound, event loop busy (no answer / empty reply / reset)
 *   HTTP 503 {state}          ─▶ starting | cloning   the server says what it is doing
 *   any other HTTP answer     ─▶ ready     (the Claude ws-server answers 200 {state:"ready",
 *                                           clone_ms}; the Codex one answers 426 to plain HTTP)
 *
 * Two bounds, because a dead server and a busy one need different patience:
 *   timeoutMs         continuous `down` (the old fail-fast bound for a crash at start)
 *   startupBudgetMs   total, while the server is up but not serving (a clone)
 * A control-plane wait, not a retry of a failed call and not a session runtime limit.
 */
import type { Sandbox } from 'e2b';

const PROBE_CURL_TIMEOUT_S = 2;
// The sandbox command wraps curl: leave room for its own round trip.
const PROBE_COMMAND_TIMEOUT_MS = 6000;
// A server that is up but not serving is polled less often than one still binding.
const STARTING_POLL_MS = 1000;

export type WsServerState = 'ready' | 'cloning' | 'starting' | 'down';

// curl exits that a server in the middle of starting (or restarting) produces: no answer in
// time, an empty reply, a reset connection. Any other failure is a broken probe, not a wait.
const CURL_STARTING_RC = new Set([28, 52, 56]);

export interface WsServerProbe {
  state: WsServerState;
  /** Duration of the clone the server reports once it has served (null before / without one). */
  cloneMs: number | null;
}

export interface WsServerWait extends WsServerProbe {
  ready: boolean;
  elapsedMs: number;
}

// A ws-server that is up but not serving (it clones the session's repo before it
// serves) may take this long before the create fails. Not a retry bound: the
// agents activity heartbeats while it waits. `startup.cloneMs` of every create
// is returned with the session and logged, so the budget is sized from
// measurements (Rose-Ai-Labs/rose, 1.2 GB .git, 2 vCPU sandbox: 173 s on
// 2026-11-06, so 10 min is about 3.4x that); override per deployment with
// CODE_AGENT_STARTUP_BUDGET_MS.
const DEFAULT_WS_STARTUP_BUDGET_MS = 10 * 60_000;

export function wsStartupBudgetMs(): number {
  const configured = Number(process.env.CODE_AGENT_STARTUP_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_WS_STARTUP_BUDGET_MS;
}

/** Shared launch readiness policy; the provider-specific initial wait stays unchanged. */
export function codeSessionWsReadyOptions(provider: 'claude' | 'codex') {
  return {
    port: 3000,
    timeoutMs: provider === 'claude' ? 10000 : 30000,
    pollMs: 100,
    startupBudgetMs: wsStartupBudgetMs(),
  };
}

const WS_READINESS_NAMES = {
  claude: { logName: 'WebSocket server', errorName: 'Claude Code WebSocket server' },
  codex: { logName: 'Codex WebSocket server', errorName: 'Codex WebSocket server' },
};

/**
 * Log one readiness outcome. Returns null when the server served; otherwise the error to throw
 * once the caller has released its sandbox.
 */
export function wsReadinessOutcome(
  log: { info(message: string): void; warn(message: string): void },
  kind: keyof typeof WS_READINESS_NAMES,
  ws: WsServerWait
): Error | null {
  const { logName, errorName } = WS_READINESS_NAMES[kind];
  if (ws.ready) {
    const clone = ws.cloneMs !== null ? ` (repo clone ${ws.cloneMs}ms)` : '';
    log.info(`${logName} ready in ${ws.elapsedMs}ms${clone}`);
    return null;
  }
  log.warn(
    `${logName} readiness check timed out after ${ws.elapsedMs}ms (server state: ${ws.state})`
  );
  return new Error(`${errorName} failed to become ready (${ws.state} after ${ws.elapsedMs}ms)`);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseServerState(body: string): { state: WsServerState; cloneMs: number | null } | null {
  try {
    const parsed = JSON.parse(body) as { state?: unknown; clone_ms?: unknown };
    const cloneMs = typeof parsed.clone_ms === 'number' ? parsed.clone_ms : null;
    if (parsed.state === 'cloning' || parsed.state === 'starting' || parsed.state === 'ready') {
      return { state: parsed.state, cloneMs };
    }
  } catch {
    // Not the Claude ws-server's JSON (Codex answers 426 text): any answer is ready.
  }
  return null;
}

export async function probeWsServer(sandbox: Sandbox, port: number): Promise<WsServerProbe> {
  let stdout: string;
  try {
    const result = await sandbox.commands.run(
      `curl -s -m ${PROBE_CURL_TIMEOUT_S} -w '\\n%{http_code}\\n' http://127.0.0.1:${port}/; echo "rc=$?"`,
      { timeoutMs: PROBE_COMMAND_TIMEOUT_MS }
    );
    stdout = result.stdout;
  } catch {
    // A transient sandbox API failure says nothing about the server; poll again.
    return { state: 'down', cloneMs: null };
  }
  const lines = stdout.trimEnd().split('\n');
  const rc = Number((lines.pop() ?? '').replace('rc=', ''));
  const httpCode = Number(lines.pop() ?? '0');
  const body = lines.join('\n');
  if (rc === 7) return { state: 'down', cloneMs: null };
  if (CURL_STARTING_RC.has(rc)) return { state: 'starting', cloneMs: null };
  if (rc !== 0) {
    // curl missing or a protocol error: a misconfigured template, never "not ready yet".
    throw new Error(`ws-server probe failed: curl rc=${rc} (${stdout.trim().slice(0, 200)})`);
  }
  const reported = parseServerState(body);
  if (httpCode === 503)
    return { state: reported?.state ?? 'starting', cloneMs: reported?.cloneMs ?? null };
  return { state: 'ready', cloneMs: reported?.cloneMs ?? null };
}

export async function waitForSandboxWsServer(
  sandbox: Sandbox,
  opts: { port: number; timeoutMs: number; pollMs: number; startupBudgetMs?: number }
): Promise<WsServerWait> {
  const started = Date.now();
  const startupBudgetMs = opts.startupBudgetMs ?? opts.timeoutMs;
  let downSince = started;
  let last: WsServerProbe = { state: 'down', cloneMs: null };
  for (;;) {
    await sleepMs(
      last.state === 'cloning' || last.state === 'starting' ? STARTING_POLL_MS : opts.pollMs
    );
    last = await probeWsServer(sandbox, opts.port);
    const now = Date.now();
    if (last.state === 'ready') return { ...last, ready: true, elapsedMs: now - started };
    if (last.state !== 'down') downSince = now;
    const expired =
      last.state === 'down' ? now - downSince >= opts.timeoutMs : now - started >= startupBudgetMs;
    if (expired) return { ...last, ready: false, elapsedMs: now - started };
  }
}
