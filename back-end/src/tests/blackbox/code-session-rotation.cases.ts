/**
 * C15 credential rotation, backend half: one case per branch. Registered by
 * code-session-usage-limit.blackbox.ts (its fixtures, DB rows and backend);
 * the agents half is agents/tests/blackbox/code_sessions.blackbox.py rotation_*.
 *
 *   (b) same provider ──► the paused sandbox resumes with the CLI conversation id
 *   (c) other provider ─► handoff prompt naming the trajectory file; the file is
 *                         in the new sandbox after the checkpoint restore
 *   (d) nothing leasable ► the next lease is the earliest reset of any path
 *   (a)(e) plan ────────► the session's provider, every shared path; a funded
 *                         Codex limit backs that deployment off until the reset
 *   (f) duplicates ─────► one lease holder, exactly one provider switch
 *   (g) secrets ────────► no credential value in an answer, a handoff or a log
 *
 * Hermetic: fake E2B over local HOMEs; nothing reaches E2B or a provider.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { checkpointCodeSession } from '../../providers/codeSessions/lifecycle';
import { localSandboxFs } from '../../providers/codeSessions/sandboxFs';
import { createWithCodeSession } from '../../providers/codeSessions/spawn';
import { CodeSessionBusyError, markPaused } from '../../providers/codeSessions/store';
import {
  __resetCodexFundedCooldown,
  codeSpawnCredentialPlan,
  codexFundedCooldownUntil,
  pickNextLease,
  reportCodeTaskUsageLimit,
  switchCodeSessionProvider,
  type SpawnCodeSession,
} from '../../providers/codeSessions/usageLimit';
import { acquireCodeSandbox } from '../../providers/e2bCodeSessionSandbox';

type SandboxStatics = Pick<typeof Sandbox, 'kill' | 'create' | 'connect'>;

export interface RotationContext {
  userId: string;
  agentId: string;
  fixtureDir: string;
  /** A command the previous CLI ran (it must show up in the handoff). */
  command: string;
  createdIntegrations: string[];
  originalSandbox: SandboxStatics;
  sealEnvelope: (plaintext: string, publicKeyPem: string) => string;
  http: (
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ status: number; data: Record<string, unknown> }>;
  otherLeasable: (name: string) => Promise<number>;
}

export function registerCodeSessionRotationCases(ctx: RotationContext): void {
  const { userId, agentId, fixtureDir, command, createdIntegrations, sealEnvelope, http } = ctx;
  const { otherLeasable } = ctx;
  const original = ctx.originalSandbox;
  const patchE2b = (overrides: Partial<Record<keyof SandboxStatics, unknown>>): void => {
    Object.assign(Sandbox, original, overrides);
  };

  /** E2B sandbox stand-in over a local HOME: /home/user maps onto `home`. */
  function fakeSandbox(home: string, sandboxId: string): Sandbox {
    const map = (value: string) => value.split('/home/user').join(home);
    const write = async (path: string, data: ArrayBuffer | Blob | string) => {
      mkdirSync(dirname(map(path)), { recursive: true });
      const bytes =
        typeof data === 'string'
          ? Buffer.from(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(data))
            : Buffer.from(await data.arrayBuffer());
      writeFileSync(map(path), bytes);
    };
    return {
      sandboxId,
      commands: {
        run: async (cmd: string, opts?: { cwd?: string }) => {
          // Never signal host processes from the stand-in (the resume path pkills
          // the previous ws-server inside the sandbox).
          if (cmd.startsWith('pkill ')) return { exitCode: 0, stdout: '', stderr: '' };
          const result = spawnSync('bash', ['-c', map(cmd)], {
            cwd: map(opts?.cwd ?? '/home/user'),
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              HOME: home,
              GIT_TERMINAL_PROMPT: '0',
            },
          });
          return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
        },
      },
      files: {
        read: async (path: string, opts?: { format?: string }) => {
          const data = readFileSync(map(path));
          return opts?.format === 'text' ? data.toString('utf8') : new Uint8Array(data);
        },
        write: async (pathOrEntries: string, data?: ArrayBuffer | Blob | string) =>
          write(pathOrEntries, data ?? ''),
      },
      pause: async () => true,
      kill: async () => undefined,
    } as unknown as Sandbox;
  }

  const CLAUDE_LOG_LINES = [
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] },
    },
    {
      type: 'user',
      toolUseResult: { stdout: 'ok', stderr: '' },
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    },
  ];

  /** A paused Claude session with a checkpoint (commit, uncommitted file, CLI log) and an E2B sandbox. */
  async function pausedClaudeSession(label: string, sandboxId: string) {
    const home = join(fixtureDir, `home-${label}`);
    const workspace = join(home, 'workspace');
    mkdirSync(workspace, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', `rose/${label}`, workspace]);
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 't@example.com']);
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'T']);
    writeFileSync(join(workspace, 'parser.ts'), 'export const parse = 1;\n');
    execFileSync('git', ['-C', workspace, 'add', '-A']);
    execFileSync('git', ['-C', workspace, 'commit', '-q', '-m', 'parser before the limit']);
    writeFileSync(join(workspace, 'wip.txt'), 'uncommitted\n');
    const logDir = join(home, '.claude', 'projects', '-ws');
    mkdirSync(logDir, { recursive: true });
    const cliLog = CLAUDE_LOG_LINES.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    writeFileSync(join(logDir, `${randomUUID()}.jsonl`), cliLog);
    const row = await prisma.codeSession.create({
      data: {
        userId,
        rootAgentId: agentId,
        ownerAgentId: agentId,
        repoKey: `rose-project:${label}`,
        repoUrl: `rose-project:${label}`,
        branch: `rose/${label}`,
        codeProvider: 'claude',
        sandboxKind: 'local',
        sandboxId: 'local-x',
      },
    });
    const ckpt = await checkpointCodeSession({
      session: row,
      fs: localSandboxFs(home),
      reason: 'usage_limit',
      agentId,
    });
    assert.ok(ckpt?.cliSessionId, 'the Claude conversation id is checkpointed');
    await markPaused(row.id);
    const session = await prisma.codeSession.update({
      where: { id: row.id },
      data: { sandboxKind: 'e2b', sandboxId },
    });
    return { session, cliLog, cliSessionId: ckpt.cliSessionId };
  }

  test('(b) a same-provider retry resumes the paused sandbox and its CLI conversation', async () => {
    const { session, cliSessionId } = await pausedClaudeSession('same-provider', 'sb-paused');
    const heldHome = join(fixtureDir, 'home-same-provider');
    const calls = { connect: [] as string[], create: 0, kill: 0 };
    patchE2b({
      connect: async (id: string) => {
        calls.connect.push(id);
        return fakeSandbox(heldHome, id);
      },
      create: async () => {
        calls.create += 1;
        throw new Error('a same-provider retry must not create a sandbox');
      },
      kill: async () => {
        calls.kill += 1;
      },
    });
    try {
      let handed: { handoff: string | null; trajectory: unknown } | null = null;
      const { session: started, fields } = await createWithCodeSession(
        {
          agentId,
          userId,
          repoUrl: 'rose-project:same-provider',
          codeProvider: 'claude',
          codeSessionId: session.id,
          leaseOwner: 'tool:retry:same',
        },
        async (codeSession, handoff) => {
          handed = { handoff, trajectory: codeSession?.handoffTrajectory ?? null };
          return acquireCodeSandbox(codeSession, 'tpl-claude', {}, 'Claude Code');
        }
      );
      assert.deepEqual(
        calls,
        { connect: ['sb-paused'], create: 0, kill: 0 },
        'same sandbox, resumed'
      );
      assert.equal(started.resumedFrom, 'paused_sandbox');
      assert.equal(
        started.cliSessionId,
        cliSessionId,
        'claude --resume gets the same conversation'
      );
      assert.equal(fields.code_session_id, session.id);
      assert.equal(fields.provider_handoff, false);
      assert.deepEqual(
        handed,
        { handoff: null, trajectory: null },
        'no handoff on the same provider'
      );
    } finally {
      Object.assign(Sandbox, original);
    }
  });

  test('(c) a provider switch writes the previous trajectory into the new sandbox and names it', async () => {
    const { session, cliLog } = await pausedClaudeSession('switch', 'sb-claude-held');
    const codexHome = join(fixtureDir, 'home-codex-sandbox');
    mkdirSync(codexHome, { recursive: true });
    const calls = { killed: [] as string[], created: [] as string[] };
    patchE2b({
      connect: async () => {
        throw new Error('the other provider never resumes the Claude sandbox');
      },
      create: async (templateId: string) => {
        calls.created.push(templateId);
        return fakeSandbox(codexHome, 'sb-codex-new');
      },
      kill: async (id: string) => {
        calls.killed.push(id);
      },
    });
    try {
      let handoffText = '';
      const { session: started, fields } = await createWithCodeSession(
        {
          agentId,
          userId,
          repoUrl: 'rose-project:switch',
          codeProvider: 'codex',
          codeSessionId: session.id,
          leaseOwner: 'tool:retry:switch',
        },
        async (codeSession: SpawnCodeSession | null, handoff) => {
          handoffText = handoff ?? '';
          // The same acquire both create paths use; it writes the trajectory after the restore.
          return acquireCodeSandbox(codeSession, 'tpl-codex', {}, 'Codex Code');
        }
      );
      const path = `/home/user/.rose/handoff/${session.id}-claude.jsonl`;
      assert.equal(fields.provider_handoff, true);
      assert.equal(fields.code_provider, 'codex');
      assert.equal(fields.code_session_id, session.id, 'the same session continues');
      assert.equal(started.resumedFrom, 'checkpoint');
      assert.deepEqual(calls, { killed: ['sb-claude-held'], created: ['tpl-codex'] });
      assert.equal(
        handoffText,
        [
          'Handoff: Claude Code worked on this task before you and stopped at a provider usage limit. ' +
            'Resume the progress it made; do not start over.',
          'Its commits and uncommitted files are already in your workspace on branch `rose/switch`.',
          `Its full trajectory (the Claude Code session log, one JSON event per line) is at ${path}. ` +
            'Read it to see what it did and what is left.',
          'Its last actions:',
          `- ran \`${command}\` (exit 0)`,
        ].join('\n')
      );
      const exported = join(codexHome, '.rose', 'handoff', `${session.id}-claude.jsonl`);
      assert.equal(
        readFileSync(exported, 'utf8'),
        cliLog,
        'the previous trajectory is in the sandbox'
      );
      assert.equal(readFileSync(join(codexHome, 'workspace', 'wip.txt'), 'utf8'), 'uncommitted\n');
      const switched = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
      assert.equal(switched.codeProvider, 'codex');
      assert.equal(switched.cliSessionId, null, 'no Claude conversation id reaches Codex');
    } finally {
      Object.assign(Sandbox, original);
    }
  });

  test('(f) duplicate concurrent retries: one lease holder and exactly one provider switch', async () => {
    const { session } = await pausedClaudeSession('duplicate', 'sb-dup-held');
    const killed: string[] = [];
    patchE2b({
      kill: async (id: string) => {
        killed.push(id);
      },
    });
    try {
      // Two tool calls retry the same session at once: one starts, one is busy.
      let starts = 0;
      const retry = (leaseOwner: string) =>
        createWithCodeSession(
          {
            agentId,
            userId,
            repoUrl: 'rose-project:duplicate',
            codeProvider: 'codex',
            codeSessionId: session.id,
            leaseOwner,
          },
          async () => {
            starts += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { resumedFrom: 'checkpoint', cliSessionId: null };
          }
        );
      const outcomes = await Promise.allSettled([retry('tool:a:call-1'), retry('tool:a:call-2')]);
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      assert.equal(starts, 1, 'exactly one agent starts');
      assert.equal(rejected.length, 1, JSON.stringify(outcomes.map((o) => o.status)));
      assert.ok(
        (rejected[0] as PromiseRejectedResult).reason instanceof CodeSessionBusyError,
        String((rejected[0] as PromiseRejectedResult).reason)
      );
      assert.deepEqual(killed, ['sb-dup-held'], 'the old sandbox is retired once');

      // The same tool call re-run by Temporal on the row it read before the switch:
      // it loses the conditional switch instead of rotating (and killing) again.
      const stale = { ...session };
      await assert.rejects(
        switchCodeSessionProvider(stale, 'codex', async (id) => {
          killed.push(id);
        }),
        CodeSessionBusyError
      );
      assert.deepEqual(killed, ['sb-dup-held'], 'no second rotation');
    } finally {
      Object.assign(Sandbox, original);
    }
  });

  test('(d) nothing leasable: the next lease is the earliest reset of any own or shared path', () => {
    const none = { claude: false, codex: false };
    const lease = pickNextLease(
      none,
      [
        {
          provider: 'claude',
          label: 'me@example.com',
          status: 'limited',
          limited_until: '2026-10-28T09:00:00.000Z',
          this_run: true,
        },
        {
          provider: 'codex',
          label: 'Codex account 1',
          status: 'reconnect',
          limited_until: null,
          this_run: false,
        },
      ],
      [
        {
          provider: 'codex',
          kind: 'pool',
          label: 'shared Codex subscriptions',
          status: 'limited',
          limited_until: '2026-10-28T07:00:00.000Z',
          available_count: 0,
          total_count: 2,
        },
        {
          provider: 'claude',
          kind: 'funded',
          label: 'funded Anthropic API key',
          status: 'limited',
          limited_until: '2026-10-28T08:00:00.000Z',
        },
        {
          provider: 'codex',
          kind: 'funded',
          label: 'funded Azure OpenAI deployment',
          status: 'unconfigured',
          limited_until: null,
        },
      ],
      'claude'
    );
    assert.deepEqual(lease, {
      provider: 'codex',
      label: 'shared Codex subscriptions',
      available_now: false,
      available_at: '2026-10-28T07:00:00.000Z',
      kind: 'pool',
    });
    assert.equal(pickNextLease(none, [], [], 'claude'), null, 'no known reset: nothing is claimed');
    assert.deepEqual(
      pickNextLease({ claude: false, codex: true }, [], [], 'claude'),
      { provider: 'codex', label: null, available_now: true, available_at: null },
      'the other provider when the preferred one has nothing'
    );
  });

  test('(a)(e) the plan names the session provider and every path; a funded Codex limit backs off until the reset', async () => {
    const session = await prisma.codeSession.create({
      data: {
        userId,
        rootAgentId: agentId,
        ownerAgentId: agentId,
        repoKey: 'rose-project:plan',
        repoUrl: 'rose-project:plan',
        codeProvider: 'codex',
      },
    });
    const viaHttp = await http(
      'GET',
      `/api/claude-code-session/credential-availability?user_id=${userId}&code_session_id=${session.id}&prefer=claude`
    );
    assert.equal(viaHttp.status, 200, JSON.stringify(viaHttp.data));
    assert.equal(
      viaHttp.data.session_provider,
      'codex',
      'a resume prefers the session’s own harness'
    );
    const outlook = viaHttp.data.outlook as { paths?: Array<{ label: string }> } | undefined;
    assert.deepEqual(
      (outlook?.paths ?? []).map((path) => path.label),
      [
        'shared Claude Code subscriptions',
        'shared Codex subscriptions',
        'funded Anthropic API key',
        'funded Azure OpenAI deployment',
      ]
    );
    const foreign = await http(
      'GET',
      `/api/claude-code-session/credential-availability?user_id=other-${randomUUID()}&code_session_id=${session.id}`
    );
    assert.equal(foreign.data.session_provider, null, 'a foreign session names no provider');

    // A funded Codex run (no login) at its limit: only that deployment backs off, until the reset.
    process.env.AZURE_FOUNDRY_ENDPOINT = 'https://codex-funded.blackbox.invalid';
    process.env.AZURE_FOUNDRY_API_KEY = 'azure-key-not-a-secret-here';
    try {
      assert.equal(
        (await codeSpawnCredentialPlan(userId)).codex || (await otherLeasable('gpt_code')) > 0,
        true,
        'the funded deployment backs Codex before its limit'
      );
      const fundedTask = await prisma.claudeCodeSession.create({
        data: { agentId, sandboxId: `sb-${randomUUID()}`, goal: 'g', codeProvider: 'codex' },
      });
      const resetsAt = new Date(Date.now() + 90 * 60 * 1000);
      const report = await reportCodeTaskUsageLimit(fundedTask.id, 'codex', resetsAt);
      assert.equal(report.marked, 'codex_funded');
      assert.equal((await codexFundedCooldownUntil())?.toISOString(), resetsAt.toISOString());
      const funded = (report.paths ?? []).find(
        (path) => path.kind === 'funded' && path.provider === 'codex'
      );
      assert.deepEqual(funded, {
        provider: 'codex',
        kind: 'funded',
        label: 'funded Azure OpenAI deployment',
        status: 'limited',
        limited_until: resetsAt.toISOString(),
      });
      const plan = await codeSpawnCredentialPlan(userId, { codeSessionId: session.id });
      assert.equal(
        plan.codex,
        (await otherLeasable('gpt_code')) > 0,
        'the limited deployment is not offered to the retry'
      );
    } finally {
      delete process.env.AZURE_FOUNDRY_ENDPOINT;
      delete process.env.AZURE_FOUNDRY_API_KEY;
      await __resetCodexFundedCooldown();
    }
  });

  test('(g) no credential value reaches a usage-limit answer, a plan, a handoff or a log line', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    ).toString('base64');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const secrets = {
      oauth: `sk-ant-oat01-SENTINEL-${randomUUID()}`,
      refresh: `sk-ant-ort01-SENTINEL-${randomUUID()}`,
      codex: `codex-access-SENTINEL-${randomUUID()}`,
      funded: `sk-ant-api03-SENTINEL-${randomUUID()}`,
      azure: `azure-SENTINEL-${randomUUID()}`,
    };
    const own = await prisma.integration.create({
      data: {
        userId,
        type: 'TOOL_SETUP',
        name: 'claude_code',
        accountId: 'secret-check@example.com',
        accountEmail: 'secret-check@example.com',
        status: 'CONNECTED',
        isActive: true,
        config: {
          encryptedCredentials: sealEnvelope(
            JSON.stringify({
              claudeAiOauth: {
                accessToken: secrets.oauth,
                refreshToken: secrets.refresh,
                expiresAt: Date.now() + 3_600_000,
              },
            }),
            pem
          ),
        },
      },
    });
    const ownCodex = await prisma.integration.create({
      data: {
        userId,
        type: 'TOOL_SETUP',
        name: 'gpt_code',
        accountId: 'secret-codex@example.com',
        accountEmail: 'secret-codex@example.com',
        status: 'CONNECTED',
        isActive: true,
        config: {
          encryptedCredentials: sealEnvelope(
            JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: secrets.codex } }),
            pem
          ),
        },
      },
    });
    createdIntegrations.push(own.id, ownCodex.id);
    process.env.CLAUDE_CODE_ANTHROPIC_API_KEY = secrets.funded;
    process.env.AZURE_FOUNDRY_ENDPOINT = 'https://codex-funded.blackbox.invalid';
    process.env.AZURE_FOUNDRY_API_KEY = secrets.azure;
    const { session } = await pausedClaudeSession('secrets', 'sb-secrets');
    const limitedTask = await prisma.claudeCodeSession.create({
      data: {
        agentId,
        sandboxId: `sb-${randomUUID()}`,
        goal: 'g',
        claudeTokenSource: 'user',
        claudeTokenIntegrationId: own.id,
      },
    });
    const printed: string[] = [];
    const writes = { out: process.stdout.write, err: process.stderr.write };
    const tap =
      (stream: typeof process.stdout.write) =>
      (chunk: unknown, ...rest: unknown[]): boolean => {
        printed.push(String(chunk));
        return (stream as (...args: unknown[]) => boolean).apply(process.stdout, [chunk, ...rest]);
      };
    process.stdout.write = tap(writes.out) as typeof process.stdout.write;
    process.stderr.write = tap(writes.err) as typeof process.stderr.write;
    patchE2b({ kill: async () => undefined });
    try {
      const answers = [
        await reportCodeTaskUsageLimit(limitedTask.id, 'claude', new Date(Date.now() + 3_600_000)),
        await codeSpawnCredentialPlan(userId, { codeSessionId: session.id }),
        (await switchCodeSessionProvider(session, 'codex', async () => undefined)).handoff,
      ];
      const visible = JSON.stringify(answers) + printed.join('');
      assert.ok(visible.includes('secret-check@example.com'), 'the account is named by its label');
      for (const [name, value] of Object.entries(secrets)) {
        assert.ok(!visible.includes(value), `${name} credential leaked`);
      }
    } finally {
      process.stdout.write = writes.out;
      process.stderr.write = writes.err;
      Object.assign(Sandbox, original);
      delete process.env.CLAUDE_CODE_ANTHROPIC_API_KEY;
      delete process.env.AZURE_FOUNDRY_ENDPOINT;
      delete process.env.AZURE_FOUNDRY_API_KEY;
    }
  });
}
