/**
 * Code agents (Claude Code / Codex in E2B) cannot open user-question or approval
 * flows. CLI authentication can coordinate with the parent Rose agent.
 *
 *   rose CLI / MCP (back-end/src/assets/rose-tools/rose.cjs, installed at
 *   ~/.rose/bin/rose in every code session)
 *     tools/list            display (inline only), send_message_to_user,
 *                           change_environment_size, cli — no approval, no pinned
 *                           question, nothing that waits for an answer
 *     tools/call <removed>  unknown tool
 *     rose approve | wait   unknown command
 *   Codex launch (e2b-templates/codex-code/ws-server.mjs buildCodexArgs)
 *     -c features.default_mode_request_user_input=false (copied to app-server)
 *
 * The Claude Code side (--disallowedTools AskUserQuestion,EnterPlanMode,
 * ExitPlanMode) is asserted on the real spawn in claude-code-ws-cli-env.test.ts.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const roseCli = resolve(__dirname, '..', '..', 'assets', 'rose-tools', 'rose.cjs');
const codexWsServer = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'e2b-templates',
  'codex-code',
  'ws-server.mjs'
);
const home = mkdtempSync(join(tmpdir(), 'code-agent-no-questions-'));

after(() => {
  rmSync(home, { recursive: true, force: true });
});

const ALLOWED_TOOLS = ['change_environment_size', 'cli', 'display', 'send_message_to_user'];
const QUESTION_ARGUMENTS = ['placement', 'options', 'allow_other'];

function roseEnv(roseDesktop: boolean): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    ROSE_TOOLS_URL: 'http://127.0.0.1:9',
    ROSE_TOOLS_TOKEN: 'unused',
    ROSE_TOOLS_ROSE_DESKTOP: roseDesktop ? '1' : '0',
  };
}

type McpReply = { id: number; result?: Record<string, unknown>; error?: { message: string } };

/** Speak MCP to the real `rose mcp` stdio server; one reply per request id. */
async function mcp(roseDesktop: boolean, requests: Record<string, unknown>[]): Promise<McpReply[]> {
  const child = spawn(process.execPath, [roseCli, 'mcp'], {
    env: roseEnv(roseDesktop),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map<number, McpReply>();
  let buffer = '';
  const done = new Promise<void>((resolveDone, rejectDone) => {
    const timer = setTimeout(
      () => rejectDone(new Error('rose mcp did not reply within 10s')),
      10_000
    );
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const reply = JSON.parse(buffer.slice(0, newline)) as McpReply;
        buffer = buffer.slice(newline + 1);
        replies.set(reply.id, reply);
        if (replies.size === requests.length) {
          clearTimeout(timer);
          resolveDone();
        }
      }
    });
  });
  requests.forEach((request, index) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, ...request })}\n`);
  });
  try {
    await done;
  } finally {
    child.kill('SIGTERM');
  }
  return requests.map((_, index) => replies.get(index + 1) as McpReply);
}

for (const roseDesktop of [false, true]) {
  const label = roseDesktop ? 'Rose Desktop' : 'stock';

  test(`rose MCP (${label}) exposes no tool that asks the user a question`, async () => {
    const [, list, approval] = await mcp(roseDesktop, [
      { method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { method: 'tools/list' },
      {
        method: 'tools/call',
        params: { name: 'request_user_approval', arguments: { question: 'May I deploy?' } },
      },
    ]);
    const tools = (list.result?.tools ?? []) as {
      name: string;
      description: string;
      inputSchema: { properties: Record<string, unknown> };
    }[];
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ALLOWED_TOOLS,
      'REGRESSION: the rose MCP server lists a tool beyond display / messages / env size / CLI'
    );
    const display = tools.find((tool) => tool.name === 'display');
    for (const argument of QUESTION_ARGUMENTS) {
      assert.ok(
        !(argument in (display?.inputSchema.properties ?? {})),
        `REGRESSION: display offers the pinned-question argument "${argument}"`
      );
    }
    for (const tool of tools) {
      if (tool.name === 'cli') {
        assert.match(tool.description, /immediate parent Rose agent/);
        assert.doesNotMatch(tool.description, /ask the user|request.*approval/i);
        assert.deepEqual(tool.inputSchema.properties.action, {
          type: 'string',
          enum: ['list', 'run', 'publish'],
        });
        for (const argument of ['question', ...QUESTION_ARGUMENTS]) {
          assert.ok(!(argument in tool.inputSchema.properties));
        }
        continue;
      }
      assert.doesNotMatch(
        tool.description,
        /\bask\b|question|approv/i,
        `${tool.name} invites asking`
      );
    }
    assert.match(
      approval.error?.message ?? '',
      /unknown tool request_user_approval/,
      'REGRESSION: request_user_approval is callable through the rose MCP server'
    );
  });

  test(`rose CLI (${label}) has no approve or wait command`, () => {
    for (const command of [
      ['approve', 'May I deploy?'],
      ['wait', 'request-1'],
    ]) {
      const run = spawnSync(process.execPath, [roseCli, ...command], {
        env: roseEnv(roseDesktop),
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(run.status, 1, `rose ${command[0]} must fail: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, new RegExp(`unknown command ${command[0]}`));
    }
    const usage = spawnSync(process.execPath, [roseCli, 'help'], {
      env: roseEnv(roseDesktop),
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(usage.status, 0);
    assert.doesNotMatch(usage.stdout, /approve|wait|--pinned|--option/);
  });
}

/** Evaluate the real buildCodexArgs from ws-server.mjs with fixed inputs. */
function codexArgs(withRoseCli: boolean): string[] {
  const source = readFileSync(codexWsServer, 'utf8');
  const parsed = ts.createSourceFile(
    codexWsServer,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const declaration = parsed.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'buildCodexArgs'
  );
  assert.ok(declaration, 'real buildCodexArgs must exist');
  const build = runInNewContext(`(${declaration.getText(parsed)})`, {
    workDir: '/home/user/workspace',
    CODEX_MODEL: 'gpt-test',
    CODEX_RESUME_SESSION_ID: '',
    sanitizedGoal: 'goal',
    home: '/home/user',
    join: (...parts: string[]) => parts.join('/'),
    existsSync: () => withRoseCli,
    codexFastModeProxy: null,
    MOBBIN_MCP_TOKEN: '',
    usingApiKey: false,
    CODEX_AZURE_MODEL: '',
    fundedProviderArgs: () => [],
  }) as (options: { useFastModeProxy: boolean }) => string[];
  return build({ useFastModeProxy: false });
}

test('Codex launches with request_user_input disabled in Default mode', () => {
  for (const withRoseCli of [false, true]) {
    const args = Array.from(codexArgs(withRoseCli));
    const overrides = args.flatMap((arg, index) => (args[index - 1] === '-c' ? [arg] : []));
    assert.ok(
      overrides.includes('features.default_mode_request_user_input=false'),
      `REGRESSION: Codex launched without disabling request_user_input: ${JSON.stringify(args)}`
    );
  }
});
