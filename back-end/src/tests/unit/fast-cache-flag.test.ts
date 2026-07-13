#!/usr/bin/env tsx
/**
 * Unit/structural tests for Fast Mode flag plumbing + invariants.
 *
 *  - #20 code-agent proxy env injected ONLY when flag on + proxy configured
 *  - #25 flag off → no env injection (inert)
 *  - #5  create-agent schema accepts the CLI/UI flag identically
 *  - #23 store has NO TTL/expiry (entries live forever)
 *  - delete-agent paths do NOT purge cache records (manual purge only)
 *  - cache entries use FAST_MODE_CACHE_DATABASE_URL while agent flags use app DB
 *  - #17/#18/#19 the cache never keys live infra (no session/sandbox/e2b cache kind)
 *
 * Run: npx tsx src/tests/unit/fast-cache-flag.test.ts
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFastModeAnthropicEnv,
  buildFastModeCodexEnv,
  codeAgentTraceHash,
} from '../../domains/fast-cache/codeAgentEnv';
import { createAgentSchema } from '../../domains/agents/types';
import { createSessionSchema as createCodexSessionSchema } from '../../domains/codex-code/types';
import {
  applyFastModeDefault,
  applyFastModeInheritance,
} from '../../domains/agents/agentLifecycleService';
import { buildChatTemporalStartParams } from '../../providers/chat/chatHandler';

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
    /^https:\/\/api\.example\.com\/anthropic-proxy\/[0-9a-f]{16}$/
  );
});

test('#20 injects CODEX_FAST_MODE_PROXY_URL with goalHash path when on', () => {
  const env = buildFastModeCodexEnv('do a thing', true, 'https://api.example.com/codex-proxy');
  assert.ok(env.CODEX_FAST_MODE_PROXY_URL);
  assert.match(
    env.CODEX_FAST_MODE_PROXY_URL!,
    /^https:\/\/api\.example\.com\/codex-proxy\/[0-9a-f]{16}$/
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
      /^https:\/\/api\.example\.com\/codex-proxy\/[0-9a-f]{16}$/
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
    /^https:\/\/api\.example\.com\/anthropic-proxy\/[0-9a-f]{16}\/record-only$/
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
    /^https:\/\/api\.example\.com\/codex-proxy\/[0-9a-f]{16}\/record-only$/
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

test('Andy root agents default Fast Mode on when flag is absent', () => {
  const body = createAgentSchema.parse({ goal: 'x' });
  applyFastModeDefault(body, '1f85ff25-6e29-4c1b-8739-f917bd101a30');
  assert.strictEqual(body.fast_mode_cache_enabled, true);
});

test('explicit Fast Mode off is preserved for Andy root agents', () => {
  const body = createAgentSchema.parse({ goal: 'x', fast_mode_cache_enabled: false });
  applyFastModeDefault(body, '1f85ff25-6e29-4c1b-8739-f917bd101a30');
  assert.strictEqual(body.fast_mode_cache_enabled, false);
});

test('non-default accounts do not default Fast Mode on', () => {
  const body = createAgentSchema.parse({ goal: 'x' });
  applyFastModeDefault(body, '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9');
  assert.strictEqual(body.fast_mode_cache_enabled, undefined);
});

test('sub-agents do not use account default Fast Mode', () => {
  const body = createAgentSchema.parse({
    goal: 'x',
    parent_agent_id: '00000000-0000-4000-8000-000000000001',
  });
  applyFastModeDefault(body, '1f85ff25-6e29-4c1b-8739-f917bd101a30');
  assert.strictEqual(body.fast_mode_cache_enabled, undefined);
});

test('sub-agents inherit Fast Mode read flag from parent when absent', () => {
  const body = createAgentSchema.parse({
    goal: 'x',
    parent_agent_id: '00000000-0000-4000-8000-000000000001',
  });
  applyFastModeInheritance(body, true);
  assert.strictEqual(body.fast_mode_cache_enabled, true);
});

test('explicit sub-agent Fast Mode off is not overwritten by inheritance', () => {
  const body = createAgentSchema.parse({
    goal: 'x',
    parent_agent_id: '00000000-0000-4000-8000-000000000001',
    fast_mode_cache_enabled: false,
  });
  applyFastModeInheritance(body, true);
  assert.strictEqual(body.fast_mode_cache_enabled, false);
});

test('batch-created sub-agents use parent Fast Mode inheritance', () => {
  const batchService = readFileSync(
    join(process.cwd(), 'src', 'domains', 'agents', 'agentBatchService.ts'),
    'utf8'
  );
  assert.ok(
    batchService.includes('applyFastModeInheritanceForBatch'),
    'batch create must resolve parent fast-mode flags before insert/start'
  );
  assert.ok(
    batchService.includes('repo.findFastModeFlagsByIds(parentIds)'),
    'batch create must bulk-fetch parent fast-mode flags'
  );
  assert.ok(
    batchService.includes(
      'applyFastModeInheritance(body, parentFlagById.get(body.parent_agent_id))'
    ),
    'batch create must apply the same inheritance helper as single create'
  );
});

// #23 — store entries live forever: no TTL/expiry column.
test('#23 FastModeCacheEntry has no TTL/expiry column', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
  const block = schema.slice(schema.indexOf('model FastModeCacheEntry'));
  const modelBlock = block.slice(0, block.indexOf('}'));
  assert.ok(/model FastModeCacheEntry/.test(modelBlock));
  assert.ok(!/expire|ttl|expiresAt|expiry/i.test(modelBlock), 'no expiry column allowed');
});

test('FastModeCacheEntry has no Agent relation or cascade', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
  const block = schema.slice(schema.indexOf('model FastModeCacheEntry'));
  const modelBlock = block.slice(0, block.indexOf('}'));
  assert.ok(!/\bAgent\b/.test(modelBlock), 'cache entries must not reference Agent');
  assert.ok(!/onDelete/i.test(modelBlock), 'cache entries must not cascade on delete');
});

test('delete-agent paths do not purge Fast Mode cache entries', () => {
  const lifecycle = readFileSync(
    join(process.cwd(), 'src', 'domains', 'agents', 'agentLifecycleService.ts'),
    'utf8'
  );
  const smsHelper = readFileSync(
    join(process.cwd(), 'src', 'providers', 'smsSupervisor', 'supervisorTools.helpers.ts'),
    'utf8'
  );
  const combinedDeletePaths = `${extractFunction(lifecycle, 'deleteAgentRecursive')}\n${extractFunction(
    smsHelper,
    'deleteAgentRecursive'
  )}`;
  assert.ok(
    !/fastModeCacheEntry/i.test(combinedDeletePaths),
    'delete path must not touch cache table'
  );
  assert.ok(
    !/cachePurge|purgeByGoalHash|fast-cache\/purge/i.test(combinedDeletePaths),
    'delete path must not purge cache'
  );
});

test('cache entry storage uses the shared Fast Mode database URL', () => {
  const repo = readFileSync(join(process.cwd(), 'src', 'providers', 'fastCacheStore.ts'), 'utf8');
  assert.ok(repo.includes('FAST_MODE_CACHE_DATABASE_URL'), 'cache DB override env is wired');
  assert.ok(
    !/FAST_MODE_CACHE_DATABASE_URL\s*\?\?\s*process\.env\.DATABASE_URL/.test(repo),
    'cache DB must not silently fall back to the active app DB'
  );
  assert.ok(
    repo.includes("NODE_ENV === 'production'") && repo.includes('throw new Error'),
    'only production may fall back to DATABASE_URL because production DATABASE_URL is the prod table'
  );
  assert.ok(
    // findMany since the fanout read-coalescing change (#735); findUnique before.
    /fastCachePrisma\.fastModeCacheEntry\.find(Unique|Many)/.test(repo),
    'cache reads use shared cache DB'
  );
  assert.ok(
    /fastCachePrisma\.fastModeCacheEntry\.upsert/.test(repo),
    'cache writes use shared cache DB'
  );
  assert.ok(
    /fastCachePrisma\.fastModeCacheEntry\.deleteMany/.test(repo),
    'manual purge uses shared cache DB'
  );
  assert.ok(/prisma\.agent\.findUnique/.test(repo), 'agent flag lookup stays on active app DB');
});

test('cache writes are last-write-wins', () => {
  const repo = readFileSync(join(process.cwd(), 'src', 'providers', 'fastCacheStore.ts'), 'utf8');
  const upsert = repo.slice(repo.indexOf('fastCachePrisma.fastModeCacheEntry.upsert'));
  assert.ok(!/update:\s*\{\s*\}/.test(upsert), 'cache upsert must not keep the first value');
  assert.ok(
    /update:\s*\{[\s\S]*value:\s*\(value \?\? null\) as object/.test(upsert),
    'cache upsert must replace value'
  );
  assert.ok(/update:\s*\{[\s\S]*blobPath/.test(upsert), 'cache upsert must replace blobPath');
  assert.ok(
    /P2002[\s\S]*fastCachePrisma\.fastModeCacheEntry\.update/.test(upsert),
    'concurrent insert races must retry update'
  );
});

test('chat router is cached before downstream chat generation', () => {
  const router = readFileSync(
    join(process.cwd(), 'src', 'providers', 'chat', 'routerLlm.ts'),
    'utf8'
  );
  assert.ok(router.includes('agentFastMode'), 'router must read Fast Mode flag');
  assert.ok(
    router.includes("contentKey(fastMode.goal, 'chat_router'"),
    'router must use a canonical request key'
  );
  assert.ok(router.includes('fastMode.writeEnabled'), 'router must honor write-through accounts');
  assert.ok(router.includes('cacheGet(cacheKey)'), 'router must read before live LLM');
  assert.ok(router.includes('cacheSet({'), 'router must store successful router output');
  assert.ok(router.includes('fast_cache.chat_router_hit'), 'router must log Fast Mode hits');
  assert.ok(router.includes('fast_cache.chat_router_miss'), 'router must log Fast Mode misses');
  assert.ok(
    router.includes('fast_cache.chat_router_write_only'),
    'router must log write-only mode'
  );
  assert.ok(router.includes('fast_cache.chat_router_stored'), 'router must log Fast Mode writes');
});

test('backend chat cache sites support write-only without reads', () => {
  const generator = readFileSync(
    join(process.cwd(), 'src', 'providers', 'chat', 'generatorLlm.ts'),
    'utf8'
  );
  const tools = readFileSync(
    join(process.cwd(), 'src', 'providers', 'chat', 'chatTools.ts'),
    'utf8'
  );
  const handler = readFileSync(
    join(process.cwd(), 'src', 'providers', 'chat', 'chatHandler.ts'),
    'utf8'
  );
  assert.ok(
    generator.includes('fastMode.writeEnabled'),
    'generator must honor write-through accounts'
  );
  assert.ok(
    generator.includes('fast_cache.chat_generator_write_only'),
    'generator must skip reads in write-only mode'
  );
  assert.ok(
    tools.includes('fastModeReadEnabled'),
    'chat web_search must split read and write flags'
  );
  assert.ok(tools.includes('fastModeWriteEnabled'), 'chat web_search must accept write-only flag');
  assert.ok(
    tools.includes('fast_cache.chat_web_search_write_only'),
    'chat web_search must log write-only mode'
  );
  assert.ok(
    handler.includes('fastMode.writeEnabled'),
    'chat handler must pass write-enabled state to web_search'
  );
});

test('chat escalation preserves Fast Mode on the root Temporal workflow', () => {
  const params = buildChatTemporalStartParams({
    agentId: 'agent-1',
    userId: 'user-1',
    goal: 'goal',
    startPhase: 'plan',
    agent: {
      goal: 'persisted goal',
      model: 'rose-labs/rose-1-ultra',
      reasoningMaxTokens: 4096,
      verifier: { type: 'default' },
      priceLimitCents: 100,
      fastModeCacheEnabled: true,
    },
  });
  assert.strictEqual(params.fastModeCacheEnabled, true);
  assert.strictEqual(params.model, 'rose-labs/rose-1-ultra');
});

test('Claude Code session service forwards persisted Fast Mode flag to E2B provider', () => {
  const service = readFileSync(
    join(process.cwd(), 'src', 'domains', 'claude-code', 'service.ts'),
    'utf8'
  );
  const createSession = extractFunction(service, 'createSession');
  assert.ok(
    createSession.includes(
      'const fastModeCacheEnabled = await repo.findAgentFastModeCache(agent_id)'
    ),
    'Claude Code createSession must read the persisted agent Fast Mode flag'
  );
  assert.ok(
    /createClaudeCodeSession\([\s\S]*fastModeCacheEnabled[\s\S]*\)/.test(createSession),
    'Claude Code createSession must pass the persisted flag into E2B env construction'
  );
});

test('Codex Code session service forwards persisted Fast Mode flag to E2B provider', () => {
  const service = readFileSync(
    join(process.cwd(), 'src', 'domains', 'codex-code', 'service.ts'),
    'utf8'
  );
  const createSession = extractFunction(service, 'createSession');
  assert.ok(
    createSession.includes(
      'const persistedFastModeCacheEnabled = await repo.findAgentFastModeCache(agent_id)'
    ),
    'Codex Code createSession must read the persisted agent Fast Mode flag'
  );
  assert.ok(
    createSession.includes(
      'const fastModeCacheEnabled = params.fast_mode_cache_enabled ?? persistedFastModeCacheEnabled'
    ),
    'Codex Code createSession must prefer the explicit request flag when present'
  );
  assert.ok(
    createSession.includes('Codex Code session Fast Mode flag mismatch'),
    'Codex Code createSession must log explicit-vs-persisted Fast Mode mismatches'
  );
  assert.ok(
    /createCodexCodeSession\([\s\S]*fastModeCacheEnabled[\s\S]*\)/.test(createSession),
    'Codex Code createSession must pass the persisted flag into E2B env construction'
  );
});

test('#17-19 no cache kind for browser session / E2B sandbox / token', () => {
  const normalize = readFileSync(
    join(process.cwd(), 'src', 'providers', 'fastCacheNormalizeConstants.ts'),
    'utf8'
  );
  const kindLine = normalize.slice(normalize.indexOf('export type CacheKind'));
  const kinds = kindLine.slice(0, kindLine.indexOf(';'));
  for (const forbidden of ['session', 'sandbox', 'e2b', 'token', 'cdp']) {
    assert.ok(!new RegExp(`'${forbidden}'`).test(kinds), `no '${forbidden}' cache kind`);
  }
  // The kinds we DO cache:
  for (const allowed of [
    'llm',
    'browser_use',
    'browser_http',
    'web_search',
    'web_fetch',
    'file',
    'anthropic',
    'codex',
  ]) {
    assert.ok(new RegExp(`'${allowed}'`).test(kinds), `expected '${allowed}' kind`);
  }
});

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} exists`);
  const bodyStart = source.indexOf('{', start);
  assert.ok(bodyStart >= 0, `${name} body starts`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} body ends`);
}

if (failures.length > 0) {
  process.stderr.write(
    `\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`
  );
  process.exit(1);
}
process.stdout.write(`\n✅ fast-cache flag/invariants: ${passed}/${passed} passed\n`);
