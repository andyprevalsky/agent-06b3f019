/**
 * Executor `code_session` for user tools (agents domains/user_tools): run a
 * published tool handler inside the calling user's own persistent code
 * session, never on the shared worker and never in another user's session.
 *
 *   POST /api/user-ui/tools/run (internal; user = X-User-Id)
 *     │ version must be the user's (owner check) ──────────────── else 404
 *     │ side_effects: the call must be claimed (callRecords) ───── else 409;
 *     │               already SUCCEEDED → stored run record, handler not run
 *     ▼
 *   resolveCodeSession(user, owner "user-tools", repo-less, lease per call)   (W5b)
 *     │ the user's tools session; one leased by a concurrent call of the same
 *     │ user → an idle parallel session or a new one, at most 4 live; beyond
 *     │ that a busy 503 the worker retries (every lookup is keyed by userId)
 *     ▼
 *   sandbox: E2B — resume the paused sandbox (fs + memory) or create one and
 *            restore the latest checkpoint (acquireCodeSessionSandbox);
 *            local HOME — USER_TOOLS_SESSION_SANDBOX=local, dev/tests only,
 *            refused in production (user code never runs on the backend host)
 *     ▼
 *   ~/.rose/user-tools/versions/<version>/tools/<t>/…   written once per version
 *   ~/.rose/user-tools/runs/<id>/        fresh cwd + HOME for this call
 *   timeout -k 5 <timeout_s> env -i … <runtime> <entry> < input.json
 *     stdout capped at 256 KB + 1 byte, stderr tail 4 KB, exit code, elapsed
 *     ▼
 *   run record ─► (side_effects) stored before the response ─► worker shapes it
 *   finally: release the lease (markPaused); the sandbox idles until its
 *   window pauses it, so the next call resumes the same session state.
 *
 * The per-call timeout bounds the user's handler process (tool.json
 * `timeout_s`, max 300 s). It is not a code-agent timeout: code agents keep
 * heartbeat-only liveness (rose-user-ui ledger row 48).
 *
 * 10k agents: per call one owner-scoped indexed session lookup, one lease
 * update and one sandbox exec; at most 4 tool sessions (sandboxes) per user,
 * however many of that user's agents call tools. No shared row, lock or
 * channel across users.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createLogger } from '../logger';
import { isProductionEnvironment } from '../productionEnvironment';
import {
  localCodeSessionHome,
  sweepExpiredCodeSessions,
  type ResumedFrom,
} from '../codeSessions/lifecycle';
import {
  e2bSandboxFs,
  localSandboxFs,
  shellQuote,
  type CodeSessionFs,
} from '../codeSessions/sandboxFs';
import {
  CodeSessionBusyError,
  markPaused,
  recordSandbox,
  resolveCodeSession,
  type CodeSessionRow,
} from '../codeSessions/store';
import {
  acquireCodeSessionSandbox,
  CODE_SANDBOX_IDLE_TIMEOUT_MS,
  codeSessionCreateOptions,
  recordE2bCodeSessionSandbox,
} from '../e2bCodeSessionSandbox';
import { createSandboxWithRetry, E2BSandboxCapacityError } from '../e2bSandboxCreate';
import { DEFAULT_CLAUDE_CODE_TEMPLATE_ID } from '../claudeCodeTemplate';
import { isSafeUserUiPath } from '../userUi/manifest';
import { readOwnedUserUiFile, userOwnsUserUiVersion } from '../userUi/store';
import { completeUserToolCall, findUserToolCall, type UserToolRun } from './callRecords';

const log = createLogger('UserToolSessionRunner');

/** ownerAgentId of a user's tools session (scoped by userId like every session). */
export const USER_TOOLS_SESSION_OWNER = 'user-tools';
/** Parallel tool sessions per user; a call beyond them while all run gets a busy 503. */
export const USER_TOOL_MAX_LIVE_SESSIONS = 4;
export const USER_TOOL_MAX_STDOUT_BYTES = 256 * 1024;
export const USER_TOOL_STDERR_TAIL_BYTES = 4 * 1024;
/** Sandbox exec bound beyond the handler's own timeout (copy, kill grace, reads). */
const RUN_EXEC_MARGIN_S = 30;
const HANDLER_PATH = '/usr/local/bin:/usr/bin:/bin';
const SETUP_FAILED_EXIT = 90;
const RUNTIME_MISSING_EXIT = 91;

export class UserToolRunError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'UserToolRunError';
  }
}

export interface UserToolRunParams {
  userId: string;
  agentId: string;
  versionId: string;
  tool: string;
  runtime: 'node' | 'python';
  entry: string;
  files: string[];
  timeoutS: number;
  inputJson: string;
  idempotencyKey: string | null;
}

export interface UserToolRunResult {
  run: UserToolRun;
  codeSessionId: string | null;
  resumedFrom: ResumedFrom | 'recorded';
  replayed: boolean;
}

export interface UserToolSandbox {
  fs: CodeSessionFs;
  resumedFrom: ResumedFrom;
}

export type UserToolSandboxProvider = (session: CodeSessionRow) => Promise<UserToolSandbox>;

let sandboxProviderOverride: UserToolSandboxProvider | null = null;

/** Test seam: replace sandbox acquisition (the session is still resolved for real). */
export function setUserToolSandboxProviderForTests(provider: UserToolSandboxProvider | null): void {
  sandboxProviderOverride = provider;
}

export function userToolSandboxMode(env: NodeJS.ProcessEnv = process.env): 'e2b' | 'local' {
  const raw = (env.USER_TOOLS_SESSION_SANDBOX ?? '').trim().toLowerCase();
  if (raw !== 'local') return 'e2b';
  if (isProductionEnvironment(env)) {
    throw new UserToolRunError(
      503,
      'USER_TOOL_SANDBOX_UNAVAILABLE',
      'USER_TOOLS_SESSION_SANDBOX=local is refused in production: user code never runs on the backend host'
    );
  }
  return 'local';
}

async function localSandbox(session: CodeSessionRow): Promise<UserToolSandbox> {
  const home = session.homeDir ?? localCodeSessionHome(session.id);
  mkdirSync(home, { recursive: true });
  const reused = session.sandboxKind === 'local' && session.homeDir === home;
  if (!reused) {
    await recordSandbox(session.id, {
      sandboxKind: 'local',
      sandboxId: `user-tools-local:${session.id}`,
      homeDir: home,
    });
  }
  return { fs: localSandboxFs(home), resumedFrom: reused ? 'local_home' : 'new' };
}

async function e2bSandbox(session: CodeSessionRow): Promise<UserToolSandbox> {
  const apiKey = process.env.E2B_API_KEY;
  const templateId =
    process.env.E2B_USER_TOOLS_TEMPLATE_ID?.trim() || DEFAULT_CLAUDE_CODE_TEMPLATE_ID;
  if (apiKey === undefined || apiKey === '') {
    throw new UserToolRunError(
      503,
      'USER_TOOL_SANDBOX_UNAVAILABLE',
      'E2B is not configured for user tool code sessions (E2B_API_KEY)'
    );
  }
  try {
    const { sandbox, resumedFrom } = await acquireCodeSessionSandbox(session, () =>
      createSandboxWithRetry(
        templateId,
        {
          apiKey,
          timeoutMs: CODE_SANDBOX_IDLE_TIMEOUT_MS,
          envs: {},
          ...codeSessionCreateOptions(session),
        },
        'User tool'
      )
    );
    await recordE2bCodeSessionSandbox(session, sandbox.sandboxId);
    return { fs: e2bSandboxFs(sandbox), resumedFrom };
  } catch (error) {
    if (error instanceof UserToolRunError) throw error;
    if (error instanceof E2BSandboxCapacityError) {
      throw new UserToolRunError(error.statusCode, error.code, error.message);
    }
    throw new UserToolRunError(
      503,
      'USER_TOOL_SANDBOX_UNAVAILABLE',
      `code session sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        500
      )
    );
  }
}

function acquireSandbox(session: CodeSessionRow): Promise<UserToolSandbox> {
  if (sandboxProviderOverride !== null) return sandboxProviderOverride(session);
  return userToolSandboxMode() === 'local' ? localSandbox(session) : e2bSandbox(session);
}

function checkFiles(params: UserToolRunParams): void {
  const prefix = `tools/${params.tool}/`;
  const bad = params.files.find((path) => !isSafeUserUiPath(path) || !path.startsWith(prefix));
  if (bad !== undefined) {
    throw new UserToolRunError(
      400,
      'INVALID_TOOL_FILES',
      `${bad.slice(0, 200)} is not under ${prefix}`
    );
  }
  if (!params.files.includes(params.entry)) {
    throw new UserToolRunError(400, 'INVALID_TOOL_FILES', 'entry must be one of the tool files');
  }
}

function runtimeCommand(runtime: 'node' | 'python'): { bin: string; args: string[] } {
  // -I: isolated mode (ignores PYTHON* env vars and the user site dir).
  return runtime === 'python' ? { bin: 'python3', args: ['-I'] } : { bin: 'node', args: [] };
}

/** Write the version's tool files into the session once (published versions are immutable). */
async function ensureVersionFiles(
  fs: CodeSessionFs,
  params: UserToolRunParams,
  versionDir: string
): Promise<void> {
  const fileHash = createHash('sha256').update(params.files.join('\n')).digest('hex').slice(0, 16);
  const marker = `${versionDir}/.ready-${params.tool}-${fileHash}`;
  const probe = await fs.exec(`test -f ${shellQuote(marker)}`, { timeoutMs: 30_000 });
  if (probe.exitCode === 0) return;
  for (const path of params.files) {
    const content = await readOwnedUserUiFile(params.userId, params.versionId, path);
    if (content === null) {
      throw new UserToolRunError(
        404,
        'USER_UI_FILE_NOT_FOUND',
        `${path} is not in version ${params.versionId}`
      );
    }
    await fs.writeFile(`${versionDir}/${path}`, content);
  }
  await fs.writeFile(marker, Buffer.from(params.files.join('\n')));
}

function runScript(
  params: UserToolRunParams,
  dirs: { run: string; ctl: string; version: string }
): string {
  const q = shellQuote;
  const { bin, args } = runtimeCommand(params.runtime);
  const env = [
    `PATH=${HANDLER_PATH}`,
    `HOME=${dirs.run}`,
    `TMPDIR=${dirs.run}`,
    'LANG=C.UTF-8',
    'LC_ALL=C.UTF-8',
    `ROSE_USER_TOOL=${params.tool}`,
    ...(params.idempotencyKey !== null ? [`ROSE_IDEMPOTENCY_KEY=${params.idempotencyKey}`] : []),
  ]
    .map(q)
    .join(' ');
  const handler = [bin, ...args, params.entry].map(q).join(' ');
  return [
    'set -u',
    `R=${q(dirs.run)}; C=${q(dirs.ctl)}; V=${q(dirs.version)}`,
    `mkdir -p "$R/tools" || exit ${SETUP_FAILED_EXIT}`,
    `cp -R "$V/tools/${params.tool}" "$R/tools/" || exit ${SETUP_FAILED_EXIT}`,
    `PATH=${q(HANDLER_PATH)} command -v ${q(bin)} >/dev/null 2>&1 || { echo ${q(`${bin} is not installed in the code session`)} >&2; exit ${RUNTIME_MISSING_EXIT}; }`,
    `cd "$R" || exit ${SETUP_FAILED_EXIT}`,
    'SECONDS=0',
    `timeout -k 5 ${params.timeoutS} env -i ${env} ${handler} < "$C/input.json" 2> "$C/stderr.full" | head -c ${USER_TOOL_MAX_STDOUT_BYTES + 1} > "$C/stdout"`,
    'rc=${PIPESTATUS[0]}',
    'echo "$SECONDS" > "$C/elapsed"',
    `tail -c ${USER_TOOL_STDERR_TAIL_BYTES} "$C/stderr.full" > "$C/stderr" 2>/dev/null; rm -f "$C/stderr.full"`,
    'echo "$rc" > "$C/rc"',
    'exit 0',
  ].join('\n');
}

async function runInSandbox(
  fs: CodeSessionFs,
  params: UserToolRunParams,
  codeSessionId: string
): Promise<UserToolRun> {
  const root = `${fs.home}/.rose/user-tools`;
  const versionDir = `${root}/versions/${params.versionId}`;
  await ensureVersionFiles(fs, params, versionDir);
  const runId = randomUUID();
  const dirs = {
    run: `${root}/runs/${runId}`,
    ctl: `${root}/runs/${runId}.ctl`,
    version: versionDir,
  };
  await fs.writeFile(`${dirs.ctl}/input.json`, Buffer.from(params.inputJson, 'utf8'));
  try {
    const exec = await fs.exec(runScript(params, dirs), {
      timeoutMs: (params.timeoutS + RUN_EXEC_MARGIN_S) * 1000,
    });
    if (exec.exitCode === SETUP_FAILED_EXIT || exec.exitCode === RUNTIME_MISSING_EXIT) {
      throw new UserToolRunError(
        503,
        'USER_TOOL_SETUP_FAILED',
        (exec.stderr.trim() || `handler setup failed (exit ${exec.exitCode})`).slice(0, 500)
      );
    }
    const rc = Number.parseInt((await fs.readFile(`${dirs.ctl}/rc`)).toString('utf8').trim(), 10);
    const elapsed = Number.parseInt(
      (await fs.readFile(`${dirs.ctl}/elapsed`)).toString('utf8').trim(),
      10
    );
    const stdout = await fs.readFile(`${dirs.ctl}/stdout`);
    const stderrTail = (await fs.readFile(`${dirs.ctl}/stderr`)).toString('utf8');
    const returncode = Number.isFinite(rc) ? rc : null;
    const timedOut = returncode === 124 || (returncode === 137 && elapsed >= params.timeoutS);
    const overflow = stdout.length > USER_TOOL_MAX_STDOUT_BYTES;
    return {
      returncode,
      stdout_b64: overflow ? '' : stdout.toString('base64'),
      stderr_tail: stderrTail.slice(-USER_TOOL_STDERR_TAIL_BYTES),
      timed_out: timedOut,
      overflow,
      executor: 'code_session',
      code_session_id: codeSessionId,
    };
  } finally {
    await fs
      .exec(`rm -rf ${shellQuote(dirs.run)} ${shellQuote(dirs.ctl)}`, { timeoutMs: 30_000 })
      .catch((error: unknown) => {
        log.warn('Removing a user tool run dir failed', {
          codeSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

/** Lease one of the caller's tools sessions (at most USER_TOOL_MAX_LIVE_SESSIONS). */
async function leaseToolSession(params: UserToolRunParams) {
  void sweepExpiredCodeSessions(params.userId);
  try {
    return await resolveCodeSession({
      userId: params.userId,
      rootAgentId: params.agentId,
      ownerAgentId: USER_TOOLS_SESSION_OWNER,
      repoUrl: null,
      codeProvider: USER_TOOLS_SESSION_OWNER,
      leaseOwner: `user-tool:${randomUUID()}`,
      maxLiveSessions: USER_TOOL_MAX_LIVE_SESSIONS,
      planBranch: () =>
        Promise.resolve({
          branch: null,
          baseBranch: null,
          mergeTarget: null,
          parentCodeSessionId: null,
        }),
    });
  } catch (error) {
    if (error instanceof CodeSessionBusyError) {
      throw new UserToolRunError(
        503,
        'USER_TOOL_SESSION_BUSY',
        `all ${USER_TOOL_MAX_LIVE_SESSIONS} of this user's tool sessions are running other calls`
      );
    }
    throw error;
  }
}

/** Run one user tool call in the caller's own code session (see the header diagram). */
export async function runUserToolInCodeSession(
  params: UserToolRunParams
): Promise<UserToolRunResult> {
  checkFiles(params);
  if (params.idempotencyKey !== null) {
    const record = await findUserToolCall(params.userId, params.idempotencyKey);
    if (record === null || record.status === 'FAILED') {
      throw new UserToolRunError(
        409,
        'TOOL_CALL_NOT_CLAIMED',
        'claim this side-effecting call before running it'
      );
    }
    if (record.status === 'SUCCEEDED') {
      const run = record.response as unknown as UserToolRun;
      return { run, codeSessionId: run.code_session_id, resumedFrom: 'recorded', replayed: true };
    }
  }
  if (!(await userOwnsUserUiVersion(params.userId, params.versionId))) {
    throw new UserToolRunError(404, 'USER_UI_VERSION_NOT_FOUND', 'Version not found');
  }
  const mode = sandboxProviderOverride === null ? userToolSandboxMode() : 'override';
  const { session, created } = await leaseToolSession(params);
  const started = Date.now();
  try {
    const sandbox = await acquireSandbox(session);
    const run = await runInSandbox(sandbox.fs, params, session.id);
    const stored =
      params.idempotencyKey !== null
        ? ((await completeUserToolCall(params.userId, params.idempotencyKey, run)) ?? run)
        : run;
    log.info('User tool ran in code session', {
      userId: params.userId,
      agentId: params.agentId,
      tool: params.tool,
      versionId: params.versionId,
      codeSessionId: session.id,
      createdSession: created,
      resumedFrom: sandbox.resumedFrom,
      sandbox: mode,
      returncode: run.returncode === null ? 'null' : String(run.returncode),
      timedOut: run.timed_out,
      durationMs: String(Date.now() - started),
    });
    return {
      run: stored,
      codeSessionId: session.id,
      resumedFrom: sandbox.resumedFrom,
      replayed: false,
    };
  } finally {
    await markPaused(session.id);
  }
}
