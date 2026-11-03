/**
 * Mobbin design references reach code agents by default, and only when the
 * backend has their token.
 *
 *   MOBBIN_MCP_TOKEN ──► withAgentTools ──► ~/.rose/mcp.json + session env
 *        ──► REAL e2b-templates/{claude-code,codex-code}/ws-server.mjs
 *        ──► fake `claude` / `codex` on PATH records the argv and env it got
 *
 * The ws-server spawn is the only place either CLI starts (E2B, the local
 * fallback and the Mac runner all run these files), so the fake sees exactly
 * the production launch. Real-CLI behaviour these flags rely on: Claude Code
 * expands `${VAR}` in --mcp-config and drops a config that names an unset one;
 * Codex reads `bearer_token_env_var` from its own env.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import {
  AGENT_TOOLS_MCP_CONFIG_PATH,
  relocateAgentToolsWorkspace,
  withAgentTools,
} from '../../providers/agentTools/workspace';
import {
  MOBBIN_MCP_TOKEN_ENV,
  MOBBIN_MCP_URL,
  mobbinAvailableFor,
} from '../../providers/agentTools/mobbin';
import { buildCodeAgentSystemPrompt } from '../../providers/codeAgentPrompt';
import { localHomeFromWorkspace } from '../../providers/localDevices/homeFiles';
import type { UserUiWorkspace } from '../../providers/userUi/workspace';

const templates = resolve(__dirname, '..', '..', '..', '..', 'e2b-templates');
const fixtureDir = mkdtempSync(join(tmpdir(), 'code-agent-mobbin-'));
const fakeBinDir = join(fixtureDir, 'bin');
mkdirSync(fakeBinDir, { recursive: true });
const SECRET = 'mobbin-test-secret-0123456789';
const SEARCH_TOOLS = ['search_screens', 'search_flows', 'search_sections'];
const ACCOUNT_TOOLS = [
  'list_collections',
  'get_collection_contents',
  'create_collection',
  'save_content',
  'add_comment',
];

// Records its own launch (atomic rename), then stays up like a CLI until ws-server goes away.
const fakeCli = `#!${process.execPath}
const fs = require('node:fs');
const capture = process.env.FAKE_CLI_CAPTURE_PATH;
fs.writeFileSync(capture + '.tmp', JSON.stringify({
  argv: process.argv.slice(2),
  mobbinToken: process.env.MOBBIN_MCP_TOKEN ?? null,
}));
fs.renameSync(capture + '.tmp', capture);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 30000);
`;
for (const name of ['claude', 'codex']) {
  writeFileSync(join(fakeBinDir, name), fakeCli);
  chmodSync(join(fakeBinDir, name), 0o755);
}

process.env.AGENT_TOOLS_TOKEN_SECRET ??= 'code-agent-mobbin-test-secret';
const savedToken = process.env[MOBBIN_MCP_TOKEN_ENV];
after(() => {
  if (savedToken === undefined) delete process.env[MOBBIN_MCP_TOKEN_ENV];
  else process.env[MOBBIN_MCP_TOKEN_ENV] = savedToken;
  rmSync(fixtureDir, { recursive: true, force: true });
});

type McpConfig = { mcpServers: Record<string, Record<string, unknown>> };

function session(home: string, token: string | null, provider: 'claude' | 'codex') {
  if (token === null) delete process.env[MOBBIN_MCP_TOKEN_ENV];
  else process.env[MOBBIN_MCP_TOKEN_ENV] = token;
  const workspace = withAgentTools(null, {
    userId: 'mobbin-test-user',
    agentId: 'mobbin-test-agent',
    taskId: `mobbin-${provider}`,
    provider,
    homeDir: home,
    roseDesktop: false,
  });
  assert.ok(workspace !== null, 'the code session still gets its Rose tools');
  return workspace;
}

function mcpConfigOf(workspace: UserUiWorkspace): McpConfig {
  const file = workspace.files.find((f) => f.path === AGENT_TOOLS_MCP_CONFIG_PATH);
  assert.ok(file, 'mcp.json installed');
  return JSON.parse(file.content.toString('utf8')) as McpConfig;
}

/** Write the session HOME files exactly as the sandbox writer lays them out. */
function materialize(home: string, workspace: UserUiWorkspace): void {
  for (const file of workspace.files) {
    mkdirSync(dirname(join(home, file.path)), { recursive: true });
    writeFileSync(join(home, file.path), file.content);
  }
}

type Launch = { argv: string[]; mobbinToken: string | null };

/** Run the real ws-server with the session env; return the CLI launch it made. */
async function launch(
  provider: 'claude' | 'codex',
  home: string,
  sessionEnvs: Record<string, string>
): Promise<Launch> {
  const capturePath = join(fixtureDir, `capture-${provider}-${Date.now()}.json`);
  const providerEnv: Record<string, string> =
    provider === 'claude'
      ? { CLAUDE_CODE_GOAL: 'build an agent display', CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth' }
      : {
          CODEX_GOAL: 'build an agent display',
          CODEX_MODEL: 'model',
          CODEX_AUTH_JSON: '{}',
          OPENAI_API_KEY: '',
          CODE_SESSION_TURN_TOKEN: 'turn-token',
        };
  // No `...process.env`: the CLI env must come from the session env alone.
  const server = spawn(
    process.execPath,
    [join(templates, provider === 'claude' ? 'claude-code' : 'codex-code', 'ws-server.mjs')],
    {
      cwd: home,
      env: {
        ...sessionEnvs,
        ...providerEnv,
        PATH: [fakeBinDir, process.env.PATH ?? ''].filter(Boolean).join(':'),
        HOME: home,
        PORT: '0',
        FAKE_CLI_CAPTURE_PATH: capturePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  server.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  server.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const exited = new Promise<void>((done) => server.once('exit', () => done()));
  // Event-driven: the fake renames its capture into place when the CLI starts.
  const started = new Promise<void>((resolveStart, rejectStart) => {
    const finish = (err?: Error): void => {
      clearTimeout(timer);
      watcher.close();
      if (err) rejectStart(err);
      else resolveStart();
    };
    const watcher = watch(fixtureDir, () => {
      if (existsSync(capturePath)) finish();
    });
    const timer = setTimeout(
      () => finish(new Error(`${provider} CLI never started within 20s:\n${output}`)),
      20_000
    );
    void exited.then(() =>
      existsSync(capturePath)
        ? finish()
        : finish(new Error(`ws-server exited before the CLI started:\n${output}`))
    );
    if (existsSync(capturePath)) finish();
  });
  try {
    await started;
    return JSON.parse(readFileSync(capturePath, 'utf8')) as Launch;
  } finally {
    if (server.exitCode === null) server.kill('SIGTERM');
    await exited;
  }
}

function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, i) => (arg === flag ? (argv[i + 1] ?? '').split(',') : []));
}

test('without MOBBIN_MCP_TOKEN: no Mobbin server, one warning, the session starts', async () => {
  const home = join(fixtureDir, 'home-unset');
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    writes.push(String(chunk));
    return write(chunk, ...rest);
  }) as typeof process.stdout.write;
  let sessions: [UserUiWorkspace, UserUiWorkspace];
  try {
    sessions = [session(home, null, 'claude'), session(home, null, 'codex')];
  } finally {
    process.stdout.write = write;
  }
  const [claude, codex] = sessions;
  const warnings = writes.filter((line) => line.includes(MOBBIN_MCP_TOKEN_ENV));
  assert.equal(warnings.length, 1, `exactly one missing-token warning: ${warnings.join('')}`);
  assert.match(warnings[0], /WARN|"warn"/);

  assert.deepEqual(Object.keys(mcpConfigOf(claude).mcpServers), ['rose']);
  assert.equal(claude.envs[MOBBIN_MCP_TOKEN_ENV], undefined);

  materialize(home, claude);
  const claudeLaunch = await launch('claude', home, claude.envs);
  assert.ok(claudeLaunch.argv.includes('--mcp-config'), 'rose MCP still configured');
  assert.ok(
    !claudeLaunch.argv.join(' ').includes('mcp__mobbin'),
    JSON.stringify(claudeLaunch.argv)
  );
  assert.equal(claudeLaunch.mobbinToken, null);

  const codexLaunch = await launch('codex', home, codex.envs);
  assert.ok(codexLaunch.argv.join(' ').includes('mcp_servers.rose.command'), 'rose MCP kept');
  assert.ok(
    !codexLaunch.argv.join(' ').includes('mcp_servers.mobbin'),
    JSON.stringify(codexLaunch.argv)
  );
});

test('with MOBBIN_MCP_TOKEN: Claude Code gets the Mobbin server, search tools only', async () => {
  const home = join(fixtureDir, 'home-claude');
  const workspace = session(home, SECRET, 'claude');
  assert.deepEqual(mcpConfigOf(workspace).mcpServers.mobbin, {
    type: 'http',
    url: MOBBIN_MCP_URL,
    headers: { Authorization: `Bearer \${${MOBBIN_MCP_TOKEN_ENV}}` },
  });
  assert.equal(workspace.envs[MOBBIN_MCP_TOKEN_ENV], SECRET, 'token rides the session env');
  for (const file of workspace.files) {
    assert.ok(!file.content.includes(SECRET), `${file.path} must not contain the token`);
  }
  // Same-host fallback and the Mac relay rewrite mcp.json; Mobbin survives both.
  const relocated = relocateAgentToolsWorkspace(workspace, '/Users/me/s', 'http://127.0.0.1:1');
  assert.ok(mcpConfigOf(relocated).mcpServers.mobbin, 'relocated config keeps Mobbin');
  assert.equal(localHomeFromWorkspace(workspace, '/Users/me/s').envs[MOBBIN_MCP_TOKEN_ENV], SECRET);

  materialize(home, workspace);
  const { argv, mobbinToken } = await launch('claude', home, workspace.envs);
  assert.equal(mobbinToken, SECRET, 'the CLI env carries the token its config expands');
  assert.equal(argv[argv.indexOf('--mcp-config') + 1], join(home, AGENT_TOOLS_MCP_CONFIG_PATH));
  assert.ok(flagValues(argv, '--allowedTools').includes('mcp__mobbin'), JSON.stringify(argv));
  const denied = flagValues(argv, '--disallowedTools');
  for (const tool of ACCOUNT_TOOLS) assert.ok(denied.includes(`mcp__mobbin__${tool}`), tool);
  for (const tool of SEARCH_TOOLS) assert.ok(!denied.includes(`mcp__mobbin__${tool}`), tool);
  for (const tool of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']) {
    assert.ok(denied.includes(tool), `${tool} stays disallowed`);
  }
});

test('with MOBBIN_MCP_TOKEN: Codex gets the Mobbin server by env bearer, search tools only', async () => {
  const home = join(fixtureDir, 'home-codex');
  const workspace = session(home, SECRET, 'codex');
  materialize(home, workspace);
  const { argv, mobbinToken } = await launch('codex', home, workspace.envs);
  assert.equal(mobbinToken, SECRET);
  const overrides = argv.flatMap((arg, i) => (arg === '-c' ? [argv[i + 1]] : []));
  assert.ok(overrides.includes(`mcp_servers.mobbin.url="${MOBBIN_MCP_URL}"`), argv.join(' '));
  assert.ok(
    overrides.includes(`mcp_servers.mobbin.bearer_token_env_var="${MOBBIN_MCP_TOKEN_ENV}"`)
  );
  assert.ok(
    overrides.includes(`mcp_servers.mobbin.enabled_tools=${JSON.stringify(SEARCH_TOOLS)}`),
    'only the catalog search tools'
  );
  assert.ok(!argv.join(' ').includes(SECRET), 'the token never appears on the command line');
  assert.ok(
    overrides.some((o) => o.startsWith('mcp_servers.rose.command')),
    'rose MCP kept'
  );
});

test('the code-agent prompt points at Mobbin only when the caller says the session has it', () => {
  const line = /search the mobbin MCP tools/;
  assert.match(buildCodeAgentSystemPrompt({ mobbin: true }), line);
  assert.doesNotMatch(buildCodeAgentSystemPrompt({ mobbin: false }), line);
  // The prompt builder never reads the environment: an env var alone cannot change its bytes.
  process.env[MOBBIN_MCP_TOKEN_ENV] = SECRET;
  assert.doesNotMatch(buildCodeAgentSystemPrompt({}), line);
  assert.ok(
    !buildCodeAgentSystemPrompt({ mobbin: true }).includes(SECRET),
    'the prompt never holds the token'
  );
});

test('the prompt gate and the installed server agree: token AND a user, else neither', () => {
  const home = join(fixtureDir, 'agree');
  mkdirSync(home, { recursive: true });
  const base = { agentId: 'mobbin-agree', taskId: 'mobbin-agree', provider: 'claude' as const };
  for (const [token, userId, expected] of [
    [SECRET, 'mobbin-test-user', true],
    [SECRET, undefined, false], // no user: withAgentTools returns the workspace unchanged
    [null, 'mobbin-test-user', false],
    [null, undefined, false],
  ] as const) {
    if (token === null) delete process.env[MOBBIN_MCP_TOKEN_ENV];
    else process.env[MOBBIN_MCP_TOKEN_ENV] = token;
    assert.equal(
      mobbinAvailableFor(userId),
      expected,
      `gate token=${token !== null} user=${userId}`
    );
    const workspace = withAgentTools(null, { ...base, userId, homeDir: home, roseDesktop: false });
    const installed = workspace !== null && hasMobbinServer(workspace);
    assert.equal(installed, expected, `server installed token=${token !== null} user=${userId}`);
  }
});

function hasMobbinServer(workspace: UserUiWorkspace): boolean {
  const file = workspace.files.find((f) => f.path === AGENT_TOOLS_MCP_CONFIG_PATH);
  return (
    file !== undefined &&
    'mobbin' in (JSON.parse(file.content.toString('utf8')) as McpConfig).mcpServers
  );
}
