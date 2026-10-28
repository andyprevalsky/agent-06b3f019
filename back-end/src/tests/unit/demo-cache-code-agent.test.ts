#!/usr/bin/env tsx
/* eslint-disable no-console */
/** Unit/structural tests for Fast Mode code-agent/provider plumbing. */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAnthropicBody } from '../../providers/rose/claudeAuth';
import { buildCodexResponsesBody } from '../../providers/rose/gptAuth';
import { getPool } from '../../providers/rose/pools';
import { buildOpenRouterBody } from '../../providers/rose/waterfall';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

test('Claude Code sandbox enables Fast Mode through a live Claude Code model alias', () => {
  const e2bProvider = readFileSync(join(process.cwd(), 'src', 'providers', 'e2b.ts'), 'utf8');
  const e2bWorkDir = readFileSync(join(process.cwd(), 'src', 'providers', 'e2bWorkDir.ts'), 'utf8');
  const wsServer = readFileSync(
    join(process.cwd(), '..', 'e2b-templates', 'claude-code', 'ws-server.mjs'),
    'utf8'
  );
  assert.ok(
    e2bProvider.includes(
      "const { envs: cliSettings } = await codeAgentCliEnvs('claude', agentId);"
    ),
    'backend must pick the Claude Code model from the shared tier table (codeAgentModels.ts)'
  );
  assert.ok(
    e2bProvider.includes('shouldEnableClaudeCodeFastMode'),
    'Claude Code Fast Mode must go through the opt-in gate (not raw write-through)'
  );
  assert.ok(
    e2bProvider.includes('shouldInjectClaudeCodeFastModeProxy'),
    'tee-proxy injection must be gated so Andy write-through cannot bypass opt-in'
  );
  assert.ok(
    !e2bProvider.includes(
      'const codeAgentFastModeActive = fastModeCacheEnabled === true || fastModeWriteEnabled'
    ),
    'must not re-enable Fast Mode from write-through alone (k=5 t5 403/cache recurrence)'
  );
  assert.ok(
    e2bProvider.includes('const injectFastModeProxy = shouldInjectClaudeCodeFastModeProxy'),
    'createClaudeCodeSession must compute injectFastModeProxy before buildFastModeAnthropicEnv'
  );
  assert.ok(
    !e2bProvider.includes('ANTHROPIC_DEFAULT_OPUS_MODEL'),
    'backend must not pin a model alias to a stale concrete model'
  );
  assert.ok(e2bProvider.includes('...cliSettings,'), 'the tier settings reach the sandbox env');
  // Speed and cache are separate: the DEMO-cache tee-proxy never turns on
  // provider fast mode; the spawning agent's speed does (codeAgentModels.ts).
  assert.ok(
    !e2bProvider.includes("CLAUDE_CODE_FAST_MODE = '1'"),
    'the Fast Mode cache proxy must not set Claude Code provider speed'
  );
  const codeAgentModels = readFileSync(
    join(process.cwd(), 'src', 'providers', 'codeAgentModels.ts'),
    'utf8'
  );
  assert.ok(
    codeAgentModels.includes("CLAUDE_CODE_SPEED: fast ? 'fast' : 'standard'") &&
      codeAgentModels.includes("CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1'"),
    'a fast agent tells Claude Code to attempt provider fast mode so Anthropic can reject/fall back by quota'
  );
  assert.ok(
    e2bProvider.includes('overlayClaudeCodeWsServer'),
    'backend must overlay the checked-in server before launch'
  );
  assert.ok(
    e2bWorkDir.includes("const CODE_AGENT_REPO_WORKDIR = '/home/user/workspace'"),
    'backend must use a stable repo workdir for cache replay'
  );
  assert.ok(
    e2bProvider.includes('buildFastModeAnthropicEnv'),
    'backend must build Anthropic Fast Mode env for Claude Code'
  );
  assert.ok(
    e2bProvider.includes('envs.ANTHROPIC_BASE_URL = fastModeEnv.ANTHROPIC_BASE_URL'),
    'backend must route Claude Code Anthropic calls through the Fast Mode proxy'
  );
  assert.ok(
    e2bProvider.includes('resolveFastModeWriteEnabled(fastModeCacheEnabled, userId)'),
    'Claude Code must write through for the allowlisted account even when reads are off'
  );
  const e2bWsOverlay = readFileSync(
    join(process.cwd(), 'src', 'providers', 'e2bWsServerOverlay.ts'),
    'utf8'
  );
  assert.ok(
    e2bProvider.includes('overlayClaudeCodeWsServer') &&
      e2bWsOverlay.includes(
        "join(process.cwd(), '..', 'e2b-templates', 'claude-code', 'ws-server.mjs')"
      ),
    'backend must overlay the checked-in Claude Code ws-server before launch'
  );
  assert.match(wsServer, /process\.env\.CLAUDE_CODE_MODEL\s*\|\|\s*["']claude-opus-5-5["']/);
  assert.ok(
    !wsServer.includes('ANTHROPIC_DEFAULT_OPUS_MODEL'),
    'wrapper must not pin a model alias to a stale concrete model'
  );
  assert.match(wsServer, /["']--model["']/, 'CLI args must include --model');
  assert.ok(wsServer.includes('CLAUDE_CODE_MODEL'), 'CLI args must pin the configured model');
  assert.ok(
    wsServer.includes('CLAUDE_CODE_FAST_MODE'),
    'wrapper must read Claude Code provider Fast Mode flag'
  );
  assert.ok(
    wsServer.includes('JSON.stringify({ fastMode: true })'),
    'wrapper must pass Fast Mode through --settings'
  );
  assert.ok(
    wsServer.includes('const REPO_WORKDIR = join(home, "workspace")') ||
      wsServer.includes("const REPO_WORKDIR = join(home, 'workspace')") ||
      wsServer.includes('const REPO_WORKDIR = "/home/user/workspace"'),
    'Claude wrapper must clone generated repos into the stable cache replay workdir'
  );
  assert.ok(
    !/workDir\s*=\s*`\/home\/user\/\$\{repoName\}`/.test(wsServer),
    'Claude wrapper must not derive the workdir from the generated repo name'
  );
});

test('Codex Code sandbox uses Fast Mode localhost proxy plumbing', () => {
  const e2bProvider = readFileSync(join(process.cwd(), 'src', 'providers', 'e2b.ts'), 'utf8');
  const wsServer = readFileSync(
    join(process.cwd(), '..', 'e2b-templates', 'codex-code', 'ws-server.mjs'),
    'utf8'
  );
  const viteConfig = readFileSync(join(process.cwd(), '..', 'front-end', 'vite.config.ts'), 'utf8');
  assert.ok(
    e2bProvider.includes('buildFastModeCodexEnv'),
    'backend must build Codex Fast Mode env'
  );
  assert.ok(
    e2bProvider.includes('CODEX_FAST_MODE_PROXY_URL'),
    'backend must inject Codex proxy URL'
  );
  assert.ok(
    e2bProvider.includes('Fast Mode: Codex code-agent cache config'),
    'backend must log Codex Fast Mode cache configuration before sandbox launch'
  );
  assert.ok(
    e2bProvider.includes('fastModeCacheEnabled === true') &&
      e2bProvider.includes(
        'Fast Mode cache is enabled for Codex code agent but no Codex proxy URL is configured'
      ),
    'read-enabled Codex Fast Mode must fail loudly instead of silently running live'
  );
  assert.ok(
    e2bProvider.includes('overlayCodexCodeWsServer'),
    'backend must overlay checked-in Codex server'
  );
  assert.ok(wsServer.includes('CODEX_FAST_MODE_PROXY_URL'), 'wrapper must read Codex proxy URL');
  assert.ok(
    wsServer.includes('chatgpt_base_url'),
    'wrapper must point Codex CLI at localhost proxy'
  );
  assert.ok(
    wsServer.includes('model_provider="fastmode"'),
    'wrapper must force Codex model calls through Fast Mode provider'
  );
  assert.ok(
    wsServer.includes('/backend-api/codex'),
    'wrapper model provider must use the ChatGPT Codex backend path'
  );
  assert.ok(
    wsServer.includes('fast_cache_proxy_request'),
    'wrapper must emit structured proxy cache events over the WebSocket'
  );
  assert.ok(
    wsServer.includes('upstream.headers.get("x-fast-mode-cache")'),
    'wrapper must record the backend demo-cache header for each proxied request'
  );
  assert.ok(
    wsServer.includes('wire_api="responses"'),
    'wrapper model provider must use Responses API wire format'
  );
  assert.ok(
    viteConfig.includes("'/codex-proxy'") &&
      viteConfig.includes("target: `http://localhost:${process.env.BACKEND_PORT || '3000'}`"),
    'public dev tunnel must proxy Codex cache traffic to backend'
  );
  assert.ok(
    wsServer.includes('/backend-api/codex/responses') === false,
    'wrapper must not cache provider paths itself'
  );
  assert.ok(
    // E2B HOME is /home/user; a local (Mac) session keeps the same HOME-relative path.
    /const REPO_WORKDIR = (["']\/home\/user\/workspace["']|join\(home, ["']workspace["']\))/.test(
      wsServer
    ),
    'Codex wrapper must clone generated repos into the stable cache replay workdir'
  );
  assert.ok(
    !/workDir\s*=\s*`\/home\/user\/\$\{repoName\}`/.test(wsServer),
    'Codex wrapper must not derive the workdir from the generated repo name'
  );
});

test('local runner preserves prod DB URL for shared cache before local override', () => {
  const runSh = readFileSync(join(process.cwd(), '..', 'scripts', 'run.sh'), 'utf8');
  const cacheExport = runSh.indexOf('FAST_MODE_CACHE_DATABASE_URL');
  const localDbExport = runSh.indexOf('export DATABASE_URL="${LOCAL_DB_URL}');
  assert.ok(cacheExport >= 0, 'runner exports FAST_MODE_CACHE_DATABASE_URL');
  assert.ok(localDbExport >= 0, 'runner exports local DATABASE_URL');
  assert.ok(
    cacheExport < localDbExport,
    'cache DB URL captured before local DATABASE_URL override'
  );
});

test('Rose provider Fast Mode maps to supported downstream request shapes', () => {
  const ultra = getPool('rose-1-ultra');
  const lite = getPool('rose-1-flash');
  const opusAuth = { ...ultra, claudeAuthModel: 'claude-opus-4-8' };
  const messages = [{ role: 'user' as const, content: 'hi' }];

  const anthropicFast = buildAnthropicBody({
    poolSpec: opusAuth,
    messages,
    speed: 'fast',
  });
  assert.strictEqual(anthropicFast.speed, 'fast');

  const opus55Anthropic = buildAnthropicBody({
    poolSpec: ultra,
    messages,
    speed: 'ultrafast',
  });
  assert.strictEqual(opus55Anthropic.speed, 'fast', 'Opus 5.5 supports Claude fast mode');

  const fableAnthropic = buildAnthropicBody({
    poolSpec: { ...ultra, claudeAuthModel: 'claude-fable-5-1' },
    messages,
    speed: 'fast',
  });
  assert.ok(
    !('speed' in fableAnthropic),
    'direct Anthropic only gets speed for supported Opus models, not Fable'
  );

  const liteAnthropic = buildAnthropicBody({
    poolSpec: lite,
    messages,
    speed: 'fast',
  });
  assert.ok(
    !('speed' in liteAnthropic),
    'direct Anthropic only gets speed for supported Opus models'
  );

  const openrouterFast = buildOpenRouterBody({
    model: 'anthropic/claude-opus-4.8',
    messages,
    speed: 'fast',
  });
  assert.strictEqual(openrouterFast.speed, 'fast');

  const codexBody = buildCodexResponsesBody({
    poolSpec: ultra,
    messages,
    serviceTier: 'priority',
    requestId: 'rid',
  });
  assert.strictEqual(
    codexBody.service_tier,
    'priority',
    'Codex/OpenAI Responses fast mode maps to priority service tier'
  );
  assert.ok(!('speed' in codexBody), 'Codex Responses backend must not receive unsupported speed');
  assert.ok(
    !('fast_mode' in codexBody),
    'Codex Responses backend must not receive unsupported fast_mode'
  );
});

test('backend chat passes provider Fast Mode from the button, not DEMO cache', () => {
  const router = readFileSync(
    join(process.cwd(), 'src', 'providers', 'chat', 'routerLlm.ts'),
    'utf8'
  );
  const generator = readFileSync(
    join(process.cwd(), 'src', 'providers', 'chat', 'generatorLlm.ts'),
    'utf8'
  );
  assert.ok(
    router.includes('const providerFastMode = fastMode.providerFastMode !== false'),
    'router must take provider Fast Mode from the button field'
  );
  assert.ok(
    generator.includes('const providerFastMode = fastMode.providerFastMode !== false'),
    'generator must take provider Fast Mode from the button field'
  );
  assert.ok(
    router.includes('provider_fast_mode: providerFastMode'),
    'router cache key keeps the legacy button bit so recorded DEMO keys still hit'
  );
  assert.ok(
    generator.includes('provider_fast_mode: providerFastMode'),
    'generator cache key keeps the legacy button bit so recorded DEMO keys still hit'
  );
  assert.ok(
    router.includes('speed: fastMode.speed') && generator.includes('speed: fastMode.speed'),
    'router and generator live calls must forward the agent speed'
  );
});

test('Rose pool registry rejects unknown pool names', () => {
  assert.throws(() => getPool('rose-2-unknown' as never), /Unknown Rose pool rose-2-unknown/);
});

// #17/#18/#19 — the cache only keys LLM/network responses, never live infra.

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`\n✅ ${passed} demo-cache code-agent/provider tests passed`);
