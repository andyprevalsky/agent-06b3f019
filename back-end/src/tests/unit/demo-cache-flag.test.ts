#!/usr/bin/env tsx
/**
 * Unit/structural tests for Fast Mode flag plumbing + invariants.
 *
 *  - #20 code-agent proxy env injected ONLY when flag on + proxy configured
 *  - #25 flag off → no env injection (inert)
 *  - #5  create-agent schema accepts the CLI/UI flag identically
 *  - World-model / Fast Mode interaction
 *
 * Defaults/inheritance: fast-mode-defaults.test.ts
 * Store/cache/chat invariants: demo-cache-flag.part2.test.ts
 * Run: npx tsx src/tests/unit/demo-cache-flag.test.ts
 */

import assert from 'node:assert';
import {
  buildFastModeAnthropicEnv,
  buildFastModeCodexEnv,
  codeAgentTraceHash,
  isE2bReachableProxyBaseUrl,
} from '../../domains/demo-cache/codeAgentEnv';
import { createAgentSchema } from '../../domains/agents/types';
import { createSessionSchema as createCodexSessionSchema } from '../../domains/codex-code/types';
import {
  applyWorldModelModeInheritance,
  assertWorldModelModeAccess,
  disableFastModeForWorldModel,
} from '../../domains/agents/agentExecutionMode';

// Proxy URLs carry an HMAC capability keyed by BACKEND_API_KEY (fail-closed without one).
process.env.BACKEND_API_KEY ??= 'demo-cache-flag-unit-key';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

// #20 — env injected when flag on + proxy configured.
test('#20 injects ANTHROPIC_BASE_URL with goalHash path when on', () => {
  const env = buildFastModeAnthropicEnv(
    'do a thing',
    true,
    'https://api.example.com/anthropic-proxy'
  );
  assert.ok(env.ANTHROPIC_BASE_URL);
  assert.match(
    env.ANTHROPIC_BASE_URL!,
    /^https:\/\/api\.example\.com\/anthropic-proxy\/[0-9a-f]{16},[0-9a-f]{32}$/
  );
});

test('#20 injects CODEX_FAST_MODE_PROXY_URL with goalHash path when on', () => {
  const env = buildFastModeCodexEnv('do a thing', true, 'https://api.example.com/codex-proxy');
  assert.ok(env.CODEX_FAST_MODE_PROXY_URL);
  assert.match(
    env.CODEX_FAST_MODE_PROXY_URL!,
    /^https:\/\/api\.example\.com\/codex-proxy\/[0-9a-f]{16},[0-9a-f]{32}$/
  );
});

test('#20 derives Codex proxy URL from Anthropic proxy URL when explicit URL is absent', () => {
  const oldAnthropic = process.env.FAST_MODE_ANTHROPIC_PROXY_URL;
  const oldCodex = process.env.FAST_MODE_CODEX_PROXY_URL;
  delete process.env.FAST_MODE_CODEX_PROXY_URL;
  process.env.FAST_MODE_ANTHROPIC_PROXY_URL = 'https://api.example.com/anthropic-proxy';
  try {
    const env = buildFastModeCodexEnv('do a thing', true);
    assert.match(
      env.CODEX_FAST_MODE_PROXY_URL!,
      /^https:\/\/api\.example\.com\/codex-proxy\/[0-9a-f]{16},[0-9a-f]{32}$/
    );
  } finally {
    if (oldAnthropic === undefined) delete process.env.FAST_MODE_ANTHROPIC_PROXY_URL;
    else process.env.FAST_MODE_ANTHROPIC_PROXY_URL = oldAnthropic;
    if (oldCodex === undefined) delete process.env.FAST_MODE_CODEX_PROXY_URL;
    else process.env.FAST_MODE_CODEX_PROXY_URL = oldCodex;
  }
});

// #25 — flag off → nothing injected (inert).
test('#25 no injection when flag off', () => {
  assert.deepStrictEqual(buildFastModeAnthropicEnv('g', false, 'https://x/p'), {});
});

test('write-only injects ANTHROPIC_BASE_URL with record-only path when flag off', () => {
  const env = buildFastModeAnthropicEnv(
    'do a thing',
    false,
    'https://api.example.com/anthropic-proxy',
    true
  );
  assert.ok(env.ANTHROPIC_BASE_URL);
  assert.match(
    env.ANTHROPIC_BASE_URL!,
    /^https:\/\/api\.example\.com\/anthropic-proxy\/[0-9a-f]{16},[0-9a-f]{32}\/record-only(\.[0-9a-f]{32})?$/
  );
});

// Owning-boundary regression: BENCHMARK_SKIP_PUBLIC_TUNNEL pins PUBLIC_BASE_URL
// to http://localhost:<frontend>. Injecting that into E2B as ANTHROPIC_BASE_URL
// causes Claude Code `ConnectionRefused` (files-in-sub-agents 2026-08-20).
test('refuses loopback Fast Mode Anthropic proxy base (E2B-unreachable)', () => {
  assert.equal(isE2bReachableProxyBaseUrl('http://localhost:56201/anthropic-proxy'), false);
  assert.equal(isE2bReachableProxyBaseUrl('http://127.0.0.1:3001/anthropic-proxy'), false);
  assert.equal(isE2bReachableProxyBaseUrl('http://[::1]:3001/anthropic-proxy'), false);
  assert.equal(isE2bReachableProxyBaseUrl('http://[::]:3001/anthropic-proxy'), false);
  assert.equal(isE2bReachableProxyBaseUrl('http://[::ffff:127.0.0.1]:3001/anthropic-proxy'), false);
  assert.equal(isE2bReachableProxyBaseUrl('http://[::ffff:7f00:1]:3001/anthropic-proxy'), false);
  assert.equal(isE2bReachableProxyBaseUrl('https://mid.trycloudflare.com/anthropic-proxy'), true);
  assert.deepStrictEqual(
    buildFastModeAnthropicEnv('tint rs.jpeg', true, 'http://localhost:56201/anthropic-proxy'),
    {}
  );
  assert.deepStrictEqual(
    buildFastModeAnthropicEnv(
      'tint rs.jpeg',
      false,
      'http://localhost:56201/anthropic-proxy',
      true
    ),
    {}
  );
  assert.deepStrictEqual(
    buildFastModeCodexEnv('tint rs.jpeg', true, 'http://localhost:56201/codex-proxy'),
    {}
  );
});

test('write-only injects CODEX_FAST_MODE_PROXY_URL with record-only path when flag off', () => {
  const env = buildFastModeCodexEnv(
    'do a thing',
    false,
    'https://api.example.com/codex-proxy',
    true
  );
  assert.ok(env.CODEX_FAST_MODE_PROXY_URL);
  assert.match(
    env.CODEX_FAST_MODE_PROXY_URL!,
    /^https:\/\/api\.example\.com\/codex-proxy\/[0-9a-f]{16},[0-9a-f]{32}\/record-only(\.[0-9a-f]{32})?$/
  );
});

test('code-agent trace key ignores synthetic GitHub repo URL and workdir', () => {
  const goal = 'Transform rs.jpeg into a yellow variant.';
  const first = codeAgentTraceHash({
    goal,
    systemPrompt:
      'Repository workflow:\n' +
      '- The repository is cloned at /home/user/agent-9b882203.\n' +
      '- Repository URL: https://github.com/rose-gh-agent/agent-9b882203.\n',
    model: 'gpt-5.4',
    runtimeFingerprint: 'template:codex-code|wrapper:abc|env:default',
    workDir: '/home/user/agent-9b882203',
    githubRepoUrl: 'https://github.com/rose-gh-agent/agent-9b882203',
  });
  const second = codeAgentTraceHash({
    goal,
    systemPrompt:
      'Repository workflow:\n' +
      '- The repository is cloned at /home/user/agent-5a063fff.\n' +
      '- Repository URL: https://github.com/rose-gh-agent/agent-5a063fff.\n',
    model: 'gpt-5.4',
    runtimeFingerprint: 'template:codex-code|wrapper:abc|env:default',
    workDir: '/home/user/agent-5a063fff',
    githubRepoUrl: 'https://github.com/rose-gh-agent/agent-5a063fff',
  });

  assert.strictEqual(second, first);
});

test('code-agent trace key still changes on goal, prompt, tools, model, and environment', () => {
  const base = {
    goal: 'Transform rs.jpeg into a yellow variant.',
    systemPrompt: 'Static code-agent instructions.',
    toolDefinitionsHash: 'tools:a',
    model: 'gpt-5.4',
    runtimeFingerprint: 'template:codex-code|wrapper:abc|env:default',
  };
  const original = codeAgentTraceHash(base);
  assert.notStrictEqual(
    codeAgentTraceHash({ ...base, goal: 'Transform rs.jpeg into blue.' }),
    original
  );
  assert.notStrictEqual(
    codeAgentTraceHash({ ...base, systemPrompt: 'Changed static code-agent instructions.' }),
    original
  );
  assert.notStrictEqual(codeAgentTraceHash({ ...base, toolDefinitionsHash: 'tools:b' }), original);
  assert.notStrictEqual(codeAgentTraceHash({ ...base, model: 'gpt-5.5' }), original);
  assert.notStrictEqual(
    codeAgentTraceHash({
      ...base,
      runtimeFingerprint: 'template:codex-code|wrapper:def|env:default',
    }),
    original
  );
});

// #20 — on but proxy URL unconfigured → no injection (degrade to direct Anthropic).
test('on but no proxy URL → no injection', () => {
  assert.deepStrictEqual(buildFastModeAnthropicEnv('g', true, ''), {});
});

// #5 — create-agent schema accepts the flag (same field for CLI + UI).
test('#5 createAgentSchema accepts fast_mode_cache_enabled', () => {
  const on = createAgentSchema.parse({ goal: 'x', fast_mode_cache_enabled: true });
  assert.strictEqual(on.fast_mode_cache_enabled, true);
  const off = createAgentSchema.parse({ goal: 'x', fast_mode_cache_enabled: false });
  assert.strictEqual(off.fast_mode_cache_enabled, false);
  const absent = createAgentSchema.parse({ goal: 'x' });
  assert.strictEqual(absent.fast_mode_cache_enabled, undefined); // route/service applies defaults
});

test('createAgentSchema accepts supported world-model modes', () => {
  const simulated = createAgentSchema.parse({ goal: 'x', world_model_mode: 'simulate' });
  assert.strictEqual(simulated.world_model_mode, 'simulate');
  assert.strictEqual(
    createAgentSchema.parse({ goal: 'x', world_model_mode: 'shadow' }).world_model_mode,
    'shadow'
  );
  assert.throws(() => createAgentSchema.parse({ goal: 'x', world_model_mode: 'bogus' }));
});

test('non-real world-model modes require a canonical admin account', () => {
  const simulated = createAgentSchema.parse({ goal: 'x', world_model_mode: 'simulate' });
  assert.doesNotThrow(() =>
    assertWorldModelModeAccess(simulated, '1f85ff25-6e29-4c1b-8739-f917bd101a30')
  );
  assert.doesNotThrow(() =>
    assertWorldModelModeAccess(simulated, '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9')
  );
  assert.throws(
    () => assertWorldModelModeAccess(simulated, '22222222-2222-4222-8222-222222222222'),
    /requires administrator access/
  );
  const real = createAgentSchema.parse({ goal: 'x', world_model_mode: 'real' });
  assert.doesNotThrow(() =>
    assertWorldModelModeAccess(real, '22222222-2222-4222-8222-222222222222')
  );
});

test('Simulator mode disables Fast Mode provider-cache reads', () => {
  const body = createAgentSchema.parse({
    goal: 'x',
    world_model_mode: 'simulate',
    fast_mode_cache_enabled: true,
  });
  disableFastModeForWorldModel(body);
  assert.strictEqual(body.fast_mode_cache_enabled, false);

  const shadow = createAgentSchema.parse({
    goal: 'x',
    world_model_mode: 'shadow',
    fast_mode_cache_enabled: true,
  });
  disableFastModeForWorldModel(shadow);
  assert.strictEqual(shadow.fast_mode_cache_enabled, false);
});

test('sub-agents inherit Simulator mode from their parent', () => {
  const body = createAgentSchema.parse({
    goal: 'x',
    parent_agent_id: '00000000-0000-4000-8000-000000000001',
    parent_workflow_id: '00000000-0000-4000-8000-000000000001',
  });
  applyWorldModelModeInheritance(body, 'simulate');
  assert.strictEqual(body.world_model_mode, 'simulate');
});

test('Codex Code createSessionSchema accepts explicit Fast Mode flag', () => {
  const on = createCodexSessionSchema.parse({
    agent_id: '11111111-1111-4111-8111-111111111111',
    goal: 'x',
    user_id: '22222222-2222-4222-8222-222222222222',
    fast_mode_cache_enabled: true,
  });
  assert.strictEqual(on.fast_mode_cache_enabled, true);

  const absent = createCodexSessionSchema.parse({
    agent_id: '11111111-1111-4111-8111-111111111111',
    goal: 'x',
    user_id: '22222222-2222-4222-8222-222222222222',
  });
  assert.strictEqual(absent.fast_mode_cache_enabled, undefined);
});

test('createAgentSchema accepts SMS source for SMS-origin sub-agents', () => {
  const body = createAgentSchema.parse({ goal: 'x', source: 'SMS' });
  assert.strictEqual(body.source, 'SMS');
});

if (failures.length > 0) {
  process.stderr.write(
    `\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`
  );
  process.exit(1);
}
process.stdout.write(`\n✅ demo-cache flag/invariants: ${passed}/${passed} passed\n`);
