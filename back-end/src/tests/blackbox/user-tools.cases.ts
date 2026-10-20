/**
 * user-tools blackbox cases: user tools executed in the caller's own persistent
 * code session, and the at-most-once record for side-effecting tools.
 * Registered by user-tools.blackbox.ts.
 *
 *   POST /api/user-ui/tools/run (internal) ──► the caller's "user-tools" CodeSession
 *        (local session HOME under USER_TOOLS_SESSION_SANDBOX=local, set by the
 *        blackbox runner) ──► handler subprocess ──► bounded run record
 *   POST /api/user-ui/tool-calls/{claim,complete,release} ──► ToolSideEffect rows
 *   in-process: runUserToolInCodeSession on the E2B path with a fake paused
 *        sandbox (Sandbox.connect) backed by a temp dir
 */
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { retireCodeSession } from '../../providers/codeSessions/lifecycle';
import { userToolOperationKey } from '../../providers/userTools/callRecords';
import {
  runUserToolInCodeSession,
  USER_TOOLS_SESSION_OWNER,
  UserToolRunError,
  userToolSandboxMode,
} from '../../providers/userTools/sessionRunner';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export interface UserToolCaseContext {
  baseUrl: string;
  apiKey: string;
  userA: () => { token: string; userId: string };
  userB: () => { token: string; userId: string };
  /** A fresh user with no code sessions yet. */
  newUser: () => Promise<{ token: string; userId: string }>;
}

interface Res {
  status: number;
  data: Record<string, unknown>;
}

interface Run {
  returncode: number | null;
  stdout_b64: string;
  stderr_tail: string;
  timed_out: boolean;
  overflow: boolean;
  executor: string;
  code_session_id: string | null;
}

const fixtureDir = mkdtempSync(join(tmpdir(), 'user-ui-tools-'));
const counterPath = join(fixtureDir, 'charges.txt');

const HANDLERS: Record<string, string> = {
  where: [
    'import json, os, sys',
    'data = json.load(sys.stdin)',
    'print(json.dumps({"cwd": os.getcwd(), "home": os.environ["HOME"], "echo": data.get("city"),',
    '                  "env": sorted(os.environ)}))',
  ].join('\n'),
  sleepy: ['import time', 'time.sleep(30)'].join('\n'),
  charge: [
    'import json, os, sys',
    'data = json.load(sys.stdin)',
    `with open(${JSON.stringify(counterPath)}, "a") as handle:`,
    '    handle.write("charge\\n")',
    'print(json.dumps({"charged": data["city"], "key": os.environ.get("ROSE_IDEMPOTENCY_KEY")}))',
  ].join('\n'),
};

function toolJson(name: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    name,
    description: `${name} tool`,
    input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    side_effects: false,
    runtime: 'python',
    entry: `tools/${name}/handler.py`,
    ...extra,
  });
}

function toolBundle(): { path: string; contentBase64: string }[] {
  const files: Record<string, string> = {
    'rose-ui.json': JSON.stringify({
      version: 1,
      tools: Object.fromEntries(
        Object.keys(HANDLERS).map((name) => [name, { manifest: `tools/${name}/tool.json` }])
      ),
    }),
  };
  for (const [name, source] of Object.entries(HANDLERS)) {
    files[`tools/${name}/tool.json`] = toolJson(
      name,
      name === 'charge' ? { side_effects: true, idempotency_key_field: 'request_id' } : {}
    );
    files[`tools/${name}/handler.py`] = source;
  }
  return Object.entries(files).map(([path, content]) => ({
    path,
    contentBase64: Buffer.from(content, 'utf8').toString('base64'),
  }));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function decodeStdout(run: Run): Record<string, unknown> {
  return JSON.parse(Buffer.from(run.stdout_b64, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function charges(): number {
  return existsSync(counterPath)
    ? readFileSync(counterPath, 'utf8').split('\n').filter(Boolean).length
    : 0;
}

export function userUiToolCases(ctx: UserToolCaseContext) {
  const versions: Record<string, string> = {};
  const createdSessionIds = new Set<string>();
  const extraUserIds: string[] = [];

  async function call(
    path: string,
    body: Record<string, unknown>,
    auth: { userId: string } | { token: string }
  ): Promise<Res> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if ('token' in auth) headers.Authorization = `Bearer ${auth.token}`;
    else {
      headers['X-API-Key'] = ctx.apiKey;
      headers['X-User-Id'] = auth.userId;
    }
    const response = await fetch(`${ctx.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { raw: text };
    }
    return { status: response.status, data };
  }

  async function versionFor(user: { token: string; userId: string }): Promise<string> {
    const cached = versions[user.userId];
    if (cached !== undefined) return cached;
    const res = await call('/api/user-ui/versions', { files: toolBundle(), activate: false }, user);
    assert(res.status === 201, `publish tools bundle: ${res.status} ${JSON.stringify(res.data)}`);
    versions[user.userId] = String(res.data.versionId);
    return versions[user.userId];
  }

  function runBody(versionId: string, tool: string, input: Record<string, unknown>, extra = {}) {
    return {
      agent_id: randomUUID(),
      version_id: versionId,
      tool,
      runtime: 'python',
      entry: `tools/${tool}/handler.py`,
      files: [`tools/${tool}/handler.py`],
      timeout_s: tool === 'sleepy' ? 1 : 20,
      input_json: JSON.stringify(input),
      ...extra,
    };
  }

  async function run(
    userId: string,
    body: Record<string, unknown>
  ): Promise<{ status: number; run: Run; data: Record<string, unknown> }> {
    const res = await call('/api/user-ui/tools/run', body, { userId });
    const sessionId = res.data.code_session_id;
    if (typeof sessionId === 'string') createdSessionIds.add(sessionId);
    return { status: res.status, run: res.data.run as Run, data: res.data };
  }

  async function cleanup(): Promise<void> {
    const userIds = [ctx.userA().userId, ctx.userB().userId, ...extraUserIds];
    const sessions = await prisma.codeSession.findMany({
      where: {
        OR: [
          { id: { in: [...createdSessionIds] } },
          { userId: { in: userIds }, ownerAgentId: USER_TOOLS_SESSION_OWNER },
        ],
      },
    });
    // Fake E2B ids are cleared by their case, so retirement never calls E2B here.
    for (const session of sessions) await retireCodeSession(session);
    await prisma.codeSession.deleteMany({ where: { id: { in: sessions.map((s) => s.id) } } });
    await prisma.toolSideEffect.deleteMany({
      where: {
        OR: userIds.map((userId) => ({ operationKey: { startsWith: `user_tool:${userId}:` } })),
      },
    });
  }

  return [
    {
      name: 'user tools: code_session run round trip in the caller own session (reused next call)',
      fn: async () => {
        const userA = ctx.userA();
        const versionId = await versionFor(userA);
        const first = await run(userA.userId, runBody(versionId, 'where', { city: 'Oslo' }));
        assert(first.status === 200, `run: ${first.status} ${JSON.stringify(first.data)}`);
        assert(first.run.returncode === 0 && !first.run.timed_out, JSON.stringify(first.run));
        const out = decodeStdout(first.run);
        assert(out.echo === 'Oslo', 'handler received the JSON input on stdin');
        const session = await prisma.codeSession.findUniqueOrThrow({
          where: { id: String(first.data.code_session_id) },
        });
        assert(session.userId === userA.userId, 'session belongs to the caller');
        assert(session.ownerAgentId === USER_TOOLS_SESSION_OWNER, 'the user tools session');
        assert(
          session.state === 'PAUSED' && session.leaseOwner === null,
          'lease released after run'
        );
        assert(
          session.homeDir !== null && String(out.cwd).startsWith(session.homeDir),
          `handler ran inside the session HOME (${String(out.cwd)} vs ${session.homeDir})`
        );
        const env = out.env as string[];
        assert(!env.includes('BACKEND_API_KEY') && !env.includes('DATABASE_URL'), 'no secrets');
        const second = await run(userA.userId, runBody(versionId, 'where', { city: 'Rome' }));
        assert(second.status === 200, `second run: ${second.status}`);
        assert(second.data.code_session_id === session.id, 'the next call reuses the same session');
        assert(second.data.resumed_from === 'local_home', 'resumed the persistent session HOME');
      },
    },
    {
      name: 'user tools: another user session and version are never used',
      fn: async () => {
        const userA = ctx.userA();
        const userB = ctx.userB();
        const versionA = await versionFor(userA);
        const versionB = await versionFor(userB);
        const a = await run(userA.userId, runBody(versionA, 'where', { city: 'a' }));
        const b = await run(userB.userId, runBody(versionB, 'where', { city: 'b' }));
        assert(a.status === 200 && b.status === 200, `runs: ${a.status} ${b.status}`);
        assert(a.data.code_session_id !== b.data.code_session_id, 'one session per user');
        const sessionB = await prisma.codeSession.findUniqueOrThrow({
          where: { id: String(b.data.code_session_id) },
        });
        assert(sessionB.userId === userB.userId, 'B ran in B session');
        const outB = decodeStdout(b.run);
        assert(
          sessionB.homeDir !== null && String(outB.cwd).startsWith(sessionB.homeDir),
          'B handler ran in B HOME'
        );
        const before = await prisma.codeSession.count({ where: { userId: userB.userId } });
        const foreign = await run(userB.userId, runBody(versionA, 'where', { city: 'x' }));
        assert(foreign.status === 404, `B with A version: ${foreign.status}`);
        assert(foreign.data.code === 'USER_UI_VERSION_NOT_FOUND', JSON.stringify(foreign.data));
        const after = await prisma.codeSession.count({ where: { userId: userB.userId } });
        assert(after === before, 'a refused call resolves no session');
        const sessionA = await prisma.codeSession.findUniqueOrThrow({
          where: { id: String(a.data.code_session_id) },
        });
        assert(sessionA.leaseOwner === null, 'A session lease untouched by B');
        const asUser = await call('/api/user-ui/tools/run', runBody(versionA, 'where', {}), userA);
        assert(asUser.status === 403, `user JWT cannot call the internal runner: ${asUser.status}`);
      },
    },
    {
      name: 'user tools: handler timeout comes back as a structured run record',
      fn: async () => {
        const userA = ctx.userA();
        const versionId = await versionFor(userA);
        const started = Date.now();
        const res = await run(userA.userId, runBody(versionId, 'sleepy', {}));
        const elapsed = Date.now() - started;
        assert(res.status === 200, `run: ${res.status} ${JSON.stringify(res.data)}`);
        assert(res.run.timed_out, `timed_out: ${JSON.stringify(res.run)}`);
        assert(elapsed < 15_000, `per-call timeout bounded the handler (${elapsed}ms)`);
      },
    },
    {
      name: 'user tools: a side-effecting call retried after a lost completion runs once',
      fn: async () => {
        const userA = ctx.userA();
        const versionId = await versionFor(userA);
        const internalA = { userId: userA.userId };
        const key = sha256(`wf-${randomUUID()}\0tc-1`);
        const input = JSON.stringify({ city: 'Lima', request_id: key });
        const claimBody = {
          idempotency_key: key,
          agent_id: 'agent-1',
          tool: 'charge',
          version_id: versionId,
          input_sha256: sha256(input),
        };
        const unclaimed = await run(
          userA.userId,
          runBody(versionId, 'charge', {}, { idempotency_key: key, input_json: input })
        );
        assert(unclaimed.status === 409, `run before claim: ${unclaimed.status}`);
        const before = charges();
        const claimed = await call('/api/user-ui/tool-calls/claim', claimBody, internalA);
        assert(claimed.data.status === 'claimed', JSON.stringify(claimed.data));
        const first = await run(
          userA.userId,
          runBody(versionId, 'charge', {}, { idempotency_key: key, input_json: input })
        );
        assert(first.status === 200 && first.run.returncode === 0, JSON.stringify(first.data));
        assert(decodeStdout(first.run).key === key, 'handler got ROSE_IDEMPOTENCY_KEY');
        assert(charges() === before + 1, 'handler ran once');
        // Lost completion: Temporal retries the activity; the claim replays the record.
        const retried = await call('/api/user-ui/tool-calls/claim', claimBody, internalA);
        assert(retried.data.status === 'done', `retry claim: ${JSON.stringify(retried.data)}`);
        assert(
          (retried.data.run as Run).stdout_b64 === first.run.stdout_b64,
          'stored record replayed'
        );
        const again = await run(
          userA.userId,
          runBody(versionId, 'charge', {}, { idempotency_key: key, input_json: input })
        );
        assert(again.status === 200 && again.data.replayed === true, JSON.stringify(again.data));
        const overwrite = await call(
          '/api/user-ui/tool-calls/complete',
          { idempotency_key: key, run: { ...first.run, stdout_b64: '' } },
          internalA
        );
        assert((overwrite.data.run as Run).stdout_b64 === first.run.stdout_b64, 'first write wins');
        assert(charges() === before + 1, 'retries never ran the handler again');
        const conflict = await call(
          '/api/user-ui/tool-calls/claim',
          { ...claimBody, input_sha256: sha256('different') },
          internalA
        );
        assert(conflict.status === 409, `same key, different call: ${conflict.status}`);
        const otherUser = await call('/api/user-ui/tool-calls/claim', claimBody, ctx.userB());
        assert(
          otherUser.status === 403,
          `a user JWT cannot reach the internal record: ${otherUser.status}`
        );
      },
    },
    {
      name: 'user tools: concurrent duplicate claims let exactly one attempt run',
      fn: async () => {
        const userA = ctx.userA();
        const versionId = await versionFor(userA);
        const key = sha256(`wf-${randomUUID()}\0tc-dup`);
        const body = {
          idempotency_key: key,
          agent_id: 'agent-1',
          tool: 'charge',
          version_id: versionId,
          input_sha256: sha256('{}'),
        };
        const claims = await Promise.all(
          Array.from({ length: 4 }, () =>
            call('/api/user-ui/tool-calls/claim', body, { userId: userA.userId })
          )
        );
        const statuses = claims.map((c) => String(c.data.status)).sort();
        assert(
          JSON.stringify(statuses) === JSON.stringify(['claimed', 'running', 'running', 'running']),
          `exactly one claim wins: ${JSON.stringify(statuses)}`
        );
        const released = await call(
          '/api/user-ui/tool-calls/release',
          { idempotency_key: key, error: 'sandbox unavailable' },
          { userId: userA.userId }
        );
        assert(released.data.status === 'released', JSON.stringify(released.data));
        const reclaimed = await call('/api/user-ui/tool-calls/claim', body, {
          userId: userA.userId,
        });
        assert(reclaimed.data.status === 'claimed', 'a released (never started) call is claimable');
        const row = await prisma.toolSideEffect.findUniqueOrThrow({
          where: { operationKey: userToolOperationKey(userA.userId, key) },
        });
        assert(row.operationType === 'user_tool.call' && row.status === 'STARTED', row.status);
      },
    },
    {
      name: 'user tools: E2B path resumes the session paused sandbox (fake sandbox)',
      fn: async () => {
        // A fresh user, so the fake paused session is that user's only tools session.
        const user = await ctx.newUser();
        extraUserIds.push(user.userId);
        const home = join(fixtureDir, 'e2b-home');
        mkdirSync(home, { recursive: true });
        const versionId = await versionFor(user);
        const session = await prisma.codeSession.create({
          data: {
            userId: user.userId,
            rootAgentId: randomUUID(),
            ownerAgentId: USER_TOOLS_SESSION_OWNER,
            repoKey: '',
            codeProvider: USER_TOOLS_SESSION_OWNER,
            state: 'PAUSED',
            sandboxKind: 'e2b',
            sandboxId: `fake-e2b-${randomUUID()}`,
          },
        });
        createdSessionIds.add(session.id);
        const commands: string[] = [];
        const map = (value: string) => value.split('/home/user').join(home);
        const fake = {
          sandboxId: session.sandboxId,
          commands: {
            run: (cmd: string) => {
              commands.push(cmd);
              // Never signal host processes: the resume path pkills a stale ws-server.
              if (cmd.includes('pkill'))
                return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
              try {
                const stdout = execFileSync('bash', ['-c', map(cmd)], {
                  cwd: home,
                  encoding: 'utf8',
                });
                return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
              } catch (error) {
                const failed = error as { status?: number; stdout?: string; stderr?: string };
                return Promise.reject(
                  Object.assign(new Error('exit'), {
                    exitCode: failed.status ?? 1,
                    stdout: String(failed.stdout ?? ''),
                    stderr: String(failed.stderr ?? ''),
                  })
                );
              }
            },
          },
          files: {
            read: (path: string) => Promise.resolve(new Uint8Array(readFileSync(map(path)))),
            write: (path: string, data: ArrayBuffer) => {
              mkdirSync(dirname(map(path)), { recursive: true });
              writeFileSync(map(path), Buffer.from(data));
              return Promise.resolve();
            },
          },
        };
        const original = Sandbox.connect.bind(Sandbox);
        const savedEnv = {
          mode: process.env.USER_TOOLS_SESSION_SANDBOX,
          key: process.env.E2B_API_KEY,
          template: process.env.E2B_CLAUDE_CODE_TEMPLATE_ID,
        };
        (Sandbox as unknown as { connect: unknown }).connect = (id: string) =>
          id === session.sandboxId
            ? Promise.resolve(fake)
            : Promise.reject(new Error(`unexpected connect ${id}`));
        delete process.env.USER_TOOLS_SESSION_SANDBOX;
        // A fake key: an unexpected create must fail, never start a real sandbox.
        process.env.E2B_API_KEY = 'test-e2b-key-not-real';
        process.env.E2B_CLAUDE_CODE_TEMPLATE_ID = 'test-template';
        try {
          const result = await runUserToolInCodeSession({
            userId: user.userId,
            agentId: randomUUID(),
            versionId,
            tool: 'where',
            runtime: 'python',
            entry: 'tools/where/handler.py',
            files: ['tools/where/handler.py'],
            timeoutS: 20,
            inputJson: JSON.stringify({ city: 'Kyiv' }),
            idempotencyKey: null,
          });
          assert(result.codeSessionId === session.id, `ran in ${result.codeSessionId}`);
          assert(result.resumedFrom === 'paused_sandbox', `resumed from ${result.resumedFrom}`);
          assert(result.run.returncode === 0, JSON.stringify(result.run));
          assert(
            String(decodeStdout(result.run).cwd).startsWith(join(home, '.rose/user-tools/runs')),
            'handler ran under the sandbox HOME'
          );
          assert(
            commands.some((cmd) => cmd.includes('timeout -k 5 20')),
            'the per-call timeout wraps the handler'
          );
          const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
          assert(
            row.sandboxId === session.sandboxId && row.leaseOwner === null,
            'recorded + released'
          );
        } finally {
          (Sandbox as unknown as { connect: unknown }).connect = original;
          if (savedEnv.mode === undefined) delete process.env.USER_TOOLS_SESSION_SANDBOX;
          else process.env.USER_TOOLS_SESSION_SANDBOX = savedEnv.mode;
          if (savedEnv.key === undefined) delete process.env.E2B_API_KEY;
          else process.env.E2B_API_KEY = savedEnv.key;
          if (savedEnv.template === undefined) delete process.env.E2B_CLAUDE_CODE_TEMPLATE_ID;
          else process.env.E2B_CLAUDE_CODE_TEMPLATE_ID = savedEnv.template;
          await prisma.codeSession.update({
            where: { id: session.id },
            data: { sandboxKind: null, sandboxId: null },
          });
        }
      },
    },
    {
      name: 'user tools: a local session sandbox is refused in production',
      fn: async () => {
        let refused: unknown = null;
        try {
          userToolSandboxMode({ USER_TOOLS_SESSION_SANDBOX: 'local', NODE_ENV: 'production' });
        } catch (error) {
          refused = error;
        }
        assert(refused instanceof UserToolRunError && refused.status === 503, 'refused in prod');
        assert(userToolSandboxMode({ USER_TOOLS_SESSION_SANDBOX: 'local' }) === 'local', 'dev ok');
        assert(userToolSandboxMode({}) === 'e2b', 'E2B by default');
      },
    },
    {
      name: 'user tools: cleanup',
      fn: async () => {
        await cleanup();
        rmSync(fixtureDir, { recursive: true, force: true });
      },
    },
  ];
}
