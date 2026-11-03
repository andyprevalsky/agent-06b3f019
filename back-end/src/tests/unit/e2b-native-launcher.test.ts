/** Actual provider launchers must not inherit root identity from filesystem snapshots. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sourcePath = resolve(__dirname, '../../providers/e2b.ts');
const originalEnvironment = { ...process.env };
type Launch = {
  command: string;
  options: {
    user?: string;
    cwd?: string;
    background?: boolean;
    timeoutMs?: number;
    envs?: Record<string, string>;
  };
};
const launches: Launch[] = [];
const sandbox = {
  sandboxId: 'filesystem-snapshot-fixture',
  getHost: () => 'snapshot.example.test',
  commands: {
    run: async (command: string, options: Launch['options']) => {
      launches.push({ command, options });
      return { exitCode: 0 };
    },
  },
};
async function boundary(path: string, namedExports: Record<string, unknown>) {
  await mock.module(path, { namedExports });
}
async function configure() {
  process.env.E2B_API_KEY = 'fixture-e2b';
  process.env.E2B_CLAUDE_CODE_TEMPLATE_ID = 'fixture-claude';
  process.env.E2B_CODEX_CODE_TEMPLATE_ID = 'fixture-codex';
  process.env.HOME = '/root/conflicting-ambient-home';
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.BACKEND_API_KEY;
  await boundary('../../providers/logger', {
    createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  });
  await boundary('../../providers/database', {
    prisma: { claudeCodeSession: { create: async () => ({}) } },
  });
  await boundary('../../providers/codeAgentFastModeEnv', {
    resolveFastModeWriteEnabled: () => false,
    fastModeProxySigningAvailable: () => false,
    buildFastModeAnthropicEnv: () => ({}),
    buildFastModeCodexEnv: () => ({}),
  });
  await boundary('../../providers/claudeCredentials', {
    fetchClaudeCodeCredentialsWithMeta: async () => null,
  });
  await boundary('../../providers/gptCredentials', {
    fetchGptCodeCredentialsWithMeta: async () => null,
  });
  await boundary('../../providers/computeCredentials', {
    isAnthropicApiKeyOnCooldown: async () => false,
  });
  await boundary('../../providers/codeAgentPrompt', {
    buildCodeAgentSystemPrompt: () => 'fixture',
    buildCodexHarnessSystemPrompt: () => 'fixture',
  });
  await boundary('../../providers/e2bAttachments', { uploadAttachmentsToSandbox: async () => [] });
  await boundary('../../providers/e2bCodexHarness', { overlayCodexRoseBridge: async () => {} });
  await boundary('../../providers/e2bWsServerOverlay', {
    fileHash: () => 'fixture',
    findLocalClaudeCodeWsServer: () => 'fixture',
    findLocalCodexCodeWsServer: () => 'fixture',
    overlayClaudeCodeWsServer: async () => {},
    overlayCodexCodeWsServer: async () => {},
  });
  await boundary('../../providers/e2bCodeSessionSandbox', {
    acquireCodeSandbox: async (
      session: unknown,
      _template: string,
      _env: unknown,
      _label: string,
      sizing: { userId?: string }
    ) => {
      assert.equal(session, null);
      assert.equal(sizing.userId, 'owner', 'stateless launcher forwards authenticated caller');
      return { sandbox, resumedFrom: 'new', cliSessionId: null };
    },
    codeSandboxUserId: (session: { userId: string } | null, userId?: string) => {
      if (session && session.userId !== userId) throw new Error('foreign session');
      return session?.userId ?? userId;
    },
    codeSessionBranchEnvs: () => ({}),
    codeSessionTaskFields: () => ({}),
    recordE2bCodeSessionSandbox: async () => {},
    createLocalCodeSessionFallback: async () => null,
    releaseSandboxAfterFailedStart: async () => {},
  });
  await boundary('../../providers/projects/workspace', {
    restoreSandboxProject: async () => ({
      envs: { HOME: '/root/conflicting-project-home', PROJECT_SETTING: 'preserved' },
      report: null,
    }),
  });
  await boundary('../../providers/e2bCreateSlot', {
    withClaudeCodeCreateSlot: async (run: () => Promise<unknown>) => run(),
  });
  await boundary('../../providers/e2bWsReady', {
    waitForSandboxWsServer: async () => ({ ready: true, elapsedMs: 0 }),
  });
  await boundary('../../providers/userUi/workspace', {
    applyUserUiSandboxEnvs: (env: Record<string, string>) => {
      env.HOME = '/root/conflicting-workspace-home';
      env.WORKSPACE_SETTING = 'preserved';
    },
    writeUserUiWorkspaceToSandboxSafe: async () => {},
  });
  await boundary('../../providers/codeSessionWorkspace', {
    prepareCodeSessionWorkspace: async () => null,
    promptFlagsForUser: () => ({}),
  });
  await boundary('../../providers/codePreview/sandbox', {
    applyPreviewUrlEnv: () => null,
    autostartRosePreview: async () => {},
  });
  await boundary('../../providers/claudeCodeSandboxAuth', {
    resolveClaudeCodeSandboxApiKey: () => ({ apiKey: 'fixture', baseUrl: null }),
    resolveClaudeCodeAuthEnvs: () => ({ AUTH_SETTING: 'preserved' }),
    resolveClaudeCodeTokenSource: () => null,
    claudeTaskIntegrationId: () => null,
    isRefreshOnlyOauthEnvelope: () => false,
    shouldEnableClaudeCodeFastMode: () => false,
    shouldIgnoreAnthropicApiKeyCooldownForSandbox: () => false,
    shouldInjectClaudeCodeFastModeProxy: () => false,
    shouldPreferSandboxAnthropicBaseUrlOverFastMode: () => false,
    shouldSkipSandboxAnthropicGatewayForOauth: () => false,
    resolveCodexAzureFunding: () => null,
    resolveCodexCodeAuthEnvs: () => ({ AUTH_SETTING: 'preserved' }),
  });
}
function checkLaunch(provider: string) {
  assert.equal(launches.length, 1, `${provider} launches exactly one coding server`);
  const { command, options } = launches[0];
  assert.equal(command, 'node /home/user/ws-server.mjs');
  assert.equal(options.user, 'user', `${provider} filesystem snapshot must launch as user`);
  assert.equal(
    options.cwd,
    '/home/user',
    `${provider} filesystem snapshot must launch in user home`
  );
  assert.equal(
    options.envs?.HOME,
    '/home/user',
    `${provider} launch overrides ambient, workspace and project HOME`
  );
  assert.equal(options.background, true);
  assert.equal(options.timeoutMs, 0);
  assert.equal(options.envs?.AUTH_SETTING, 'preserved');
  assert.equal(options.envs?.WORKSPACE_SETTING, 'preserved');
  if (provider === 'claude') assert.equal(options.envs?.PROJECT_SETTING, 'preserved');
}
async function exercise(modulePath: string, provider: string) {
  launches.length = 0;
  const runtime = await import(modulePath);
  const foreignSession = { userId: 'someone-else' };
  if (provider === 'claude') {
    await assert.rejects(
      runtime.createClaudeCodeSession('agent', 'fixture task', [], undefined, 'owner', false, {
        codeSession: foreignSession,
      }),
      /foreign session/
    );
  } else {
    await assert.rejects(
      runtime.createCodexCodeSession(
        'agent',
        'fixture task',
        [],
        undefined,
        'owner',
        'standard',
        undefined,
        foreignSession
      ),
      /foreign session/
    );
  }
  assert.equal(launches.length, 0, 'foreign session rejected before launch');
  if (provider === 'claude')
    await runtime.createClaudeCodeSession('agent', 'fixture task', [], undefined, 'owner', false);
  else await runtime.createCodexCodeSession('agent', 'fixture task', [], undefined, 'owner', 'standard');
  checkLaunch(provider);
}
async function mutationProof() {
  const source = await readFile(sourcePath, 'utf8');
  for (const provider of ['claude', 'codex']) {
    for (const field of ['user', 'cwd', 'HOME']) {
      let changed = source;
      if (field === 'HOME')
        changed = changed
          .replaceAll("envs: { ...sessionEnvs, HOME: '/home/user' }", 'envs: sessionEnvs')
          .replaceAll("envs: { ...envs, HOME: '/home/user' }", 'envs');
      else
        changed = changed.replaceAll(
          `      ${field}: '${field === 'user' ? 'user' : '/home/user'}',\n`,
          ''
        );
      assert.notEqual(changed, source, `mutation ${field} must affect the actual launcher`);
      const copy = join(
        dirname(sourcePath),
        `.e2b-launcher-mutation-${process.pid}-${provider}-${field}.ts`
      );
      await writeFile(copy, changed);
      try {
        let failure: unknown;
        try {
          await exec(
            process.execPath,
            ['--experimental-test-module-mocks', '--import', 'tsx', __filename],
            {
              env: {
                ...originalEnvironment,
                E2B_LAUNCHER_MUTATION_PATH: copy,
                E2B_LAUNCHER_MUTATION_PROVIDER: provider,
              },
              timeout: 30_000,
              maxBuffer: 1024 * 1024,
            }
          );
        } catch (error) {
          failure = error;
        }
        assert(failure, `${provider} missing ${field} must fail the regression`);
        assert.match(
          String((failure as { stderr?: string }).stderr),
          /AssertionError/,
          'mutation must fail assertions, not test setup'
        );
      } finally {
        await unlink(copy);
      }
    }
  }
}
async function main() {
  await configure();
  if (process.env.E2B_LAUNCHER_MUTATION_PATH) {
    await exercise(
      pathToFileURL(process.env.E2B_LAUNCHER_MUTATION_PATH).href,
      process.env.E2B_LAUNCHER_MUTATION_PROVIDER!
    );
    return;
  }
  await exercise(pathToFileURL(sourcePath).href, 'claude');
  await exercise(pathToFileURL(sourcePath).href, 'codex');
  await mutationProof();
  process.stdout.write(
    'Actual Claude/Codex launchers: user/cwd/HOME enforced; conflicting HOME overridden; six missing-option mutations rejected\n'
  );
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
