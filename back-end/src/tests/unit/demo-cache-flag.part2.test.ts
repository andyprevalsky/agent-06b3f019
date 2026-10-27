#!/usr/bin/env tsx
/**
 * Fast Mode store/cache/chat invariants (split from demo-cache-flag.test.ts for max-lines).
 *
 *  - #23 store has NO TTL/expiry (entries live forever)
 *  - delete-agent paths do NOT purge cache records (manual purge only)
 *  - cache entries use FAST_MODE_CACHE_DATABASE_URL while agent flags use app DB
 *  - #17/#18/#19 the cache never keys live infra (no session/sandbox/e2b cache kind)
 *
 * Run: npx tsx src/tests/unit/demo-cache-flag.part2.test.ts
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const kill = readFileSync(join(process.cwd(), 'src', 'providers', 'agentKill.ts'), 'utf8');
  const deletePath = extractFunction(kill, 'deleteAgentRecursive');
  assert.ok(!/fastModeCacheEntry/i.test(deletePath), 'delete path must not touch cache table');
  assert.ok(
    !/cachePurge|purgeByGoalHash|demo-cache\/purge/i.test(deletePath),
    'delete path must not purge cache'
  );
  assert.ok(
    /DEMO cache entries intentionally outlive/.test(kill),
    'canonical kill must document that cache outlives deletion'
  );
});

test('cache entry storage uses the shared Fast Mode database URL', () => {
  const repo = readFileSync(join(process.cwd(), 'src', 'providers', 'demoCacheStore.ts'), 'utf8');
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
    /demoCachePrisma\.fastModeCacheEntry\.find(Unique|Many)/.test(repo),
    'cache reads use shared cache DB'
  );
  assert.ok(
    /demoCachePrisma\.fastModeCacheEntry\.upsert/.test(repo),
    'cache writes use shared cache DB'
  );
  assert.ok(
    /demoCachePrisma\.fastModeCacheEntry\.deleteMany/.test(repo),
    'manual purge uses shared cache DB'
  );
  assert.ok(/prisma\.agent\.findUnique/.test(repo), 'agent flag lookup stays on active app DB');
  assert.ok(
    /export async function cacheGetPosition/.test(repo),
    'position fallback must be available for OAi-demo fingerprint drift'
  );
  assert.ok(
    /getDemoCachePrisma\(\)\.\$queryRawUnsafe/.test(repo),
    'cacheGetPosition must use the real Prisma client, not the fastModeCacheEntry proxy'
  );
  assert.ok(
    !/demoCachePrisma\.\$queryRawUnsafe/.test(repo),
    'cacheGetPosition must not call $queryRawUnsafe on the model-only proxy'
  );
});

test('demo-cache routes expose get-position for durable trajectory replay', () => {
  const routes = readFileSync(
    join(process.cwd(), 'src', 'domains', 'demo-cache', 'routes.ts'),
    'utf8'
  );
  assert.ok(routes.includes("'/get-position'"), 'get-position route registered');
  assert.ok(routes.includes('cacheGetPosition'), 'get-position calls store helper');
});

test('Andy and Tamy are Fast Mode write-through accounts', () => {
  const policy = readFileSync(
    join(process.cwd(), 'src', 'providers', 'demoCacheAccountPolicy.ts'),
    'utf8'
  );
  assert.ok(policy.includes('1f85ff25-6e29-4c1b-8739-f917bd101a30'), 'Andy write-through');
  assert.ok(policy.includes('43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9'), 'Tamy write-through');
});

test('cache writes are last-write-wins', () => {
  const repo = readFileSync(join(process.cwd(), 'src', 'providers', 'demoCacheStore.ts'), 'utf8');
  const upsert = repo.slice(repo.indexOf('demoCachePrisma.fastModeCacheEntry.upsert'));
  assert.ok(!/update:\s*\{\s*\}/.test(upsert), 'cache upsert must not keep the first value');
  assert.ok(
    /update:\s*\{[\s\S]*value:\s*\(stored \?\? null\) as object/.test(upsert) &&
      /const stored = prepared \? prepared\.marker : value;/.test(repo),
    'cache upsert must replace value'
  );
  assert.ok(/update:\s*\{[\s\S]*blobPath/.test(upsert), 'cache upsert must replace blobPath');
  assert.ok(
    /P2002[\s\S]*demoCachePrisma\.fastModeCacheEntry\.update/.test(upsert),
    'concurrent insert races must retry update'
  );
});

test('chat router caches successful output without gating downstream work', () => {
  const router = readFileSync(
    join(process.cwd(), 'src', 'providers', 'chat', 'routerLlm.ts'),
    'utf8'
  );
  const routerRead = readFileSync(
    join(process.cwd(), 'src', 'providers', 'chat', 'routerDemoCache.ts'),
    'utf8'
  );
  assert.ok(router.includes('agentFastMode'), 'router must read Fast Mode flag');
  assert.ok(
    router.includes('contentKey(fastMode.goal, routerStage.callSite') &&
      /initial: \{\s*callSite: 'chat_router',/.test(router) &&
      /after_search: \{\s*callSite: 'chat_router_after_search',/.test(router),
    'router must use a canonical request key per stage; the first route keeps chat_router'
  );
  assert.ok(router.includes('fastMode.writeEnabled'), 'router must honor write-through accounts');
  assert.ok(
    router.includes('readCache: () => readRouterDemoCache('),
    'router must read through the shared router cache lookup before live LLM'
  );
  assert.ok(routerRead.includes('cacheGet(cacheKey)'), 'router must read before live LLM');
  assert.ok(
    router.includes('awaitCacheFirst: isOaiDemoGoal(fastMode.goal)'),
    'router must wait for cache only on the OAi demo Fast Mode goal'
  );
  assert.ok(router.includes('cacheSet({'), 'router must store successful router output');
  assert.ok(
    routerRead.includes('isValidRouterCacheJson(json)') &&
      routerRead.includes('isValidRouterCacheJson(replay)'),
    'router must validate exact and drift-replayed output before accepting a hit'
  );
  assert.ok(
    router.indexOf('cacheSet({') > router.indexOf('requireRouterDecision'),
    'router must validate generated output before caching it'
  );
  assert.ok(routerRead.includes('demo_cache.chat_router_hit'), 'router must log Fast Mode hits');
  assert.ok(
    routerRead.includes('demo_cache.chat_router_drift_hit'),
    'router must log drift replays'
  );
  assert.ok(routerRead.includes('demo_cache.chat_router_miss'), 'router must log Fast Mode misses');
  assert.ok(
    router.includes('demo_cache.chat_router_write_only'),
    'router must log write-only mode'
  );
  assert.ok(router.includes('demo_cache.chat_router_stored'), 'router must log Fast Mode writes');
  assert.ok(
    router.includes('fcKey && fastModeRead && !skipDemoCache'),
    'router must skip Fast Mode cache only after a cache-won miss'
  );
  assert.doesNotMatch(
    router,
    /await cacheSet\(/,
    'writing the optional router cache must not gate a lifecycle decision'
  );
});

test('web search caches successful output without gating the final answer', () => {
  const tools = readFileSync(
    join(process.cwd(), 'src', 'providers', 'chat', 'chatTools.ts'),
    'utf8'
  );
  assert.ok(tools.includes('cacheSet({'), 'web search must store successful search output');
  assert.doesNotMatch(
    tools,
    /await cacheSet\(/,
    'writing the optional web-search cache must not gate the final answer'
  );
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
  const searchRound = readFileSync(
    join(process.cwd(), 'src', 'providers', 'chat', 'chatWebSearchRound.ts'),
    'utf8'
  );
  assert.ok(
    generator.includes('fastMode.writeEnabled'),
    'generator must honor write-through accounts'
  );
  assert.ok(
    generator.includes('demo_cache.chat_generator_write_only'),
    'generator must skip reads in write-only mode'
  );
  assert.ok(
    generator.includes('fcKey && fastModeRead && !skipDemoCache'),
    'generator must skip Fast Mode cache only after a cache-won miss'
  );
  assert.ok(
    tools.includes('fastModeReadEnabled'),
    'chat web_search must split read and write flags'
  );
  assert.ok(tools.includes('fastModeWriteEnabled'), 'chat web_search must accept write-only flag');
  assert.ok(
    tools.includes('demo_cache.chat_web_search_write_only'),
    'chat web_search must log write-only mode'
  );
  assert.ok(
    searchRound.includes('fastMode.writeEnabled'),
    'the chat search round must pass write-enabled state to web_search'
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
      worldModelMode: 'simulate',
    },
  });
  assert.strictEqual(params.fastModeCacheEnabled, true);
  assert.strictEqual(params.worldModelMode, 'simulate');
  assert.strictEqual(params.model, 'rose-labs/rose-1-ultra');
});

test('Claude Code session service gates proxy on DEMO cache, not the Fast Mode button', () => {
  const service = readFileSync(
    join(process.cwd(), 'src', 'domains', 'claude-code', 'service.ts'),
    'utf8'
  );
  const createSession = extractFunction(service, 'createSession');
  assert.ok(
    createSession.includes('agentFastMode'),
    'Claude Code createSession must resolve DEMO cache via agentFastMode'
  );
  assert.ok(
    createSession.includes('const fastModeCacheEnabled = fastMode.enabled'),
    'Claude Code createSession must use demo cache enabled for the proxy'
  );
  assert.ok(
    /createClaudeCodeSession\([\s\S]*fastModeCacheEnabled[\s\S]*\)/.test(createSession),
    'Claude Code createSession must pass the demo cache flag into E2B env construction'
  );
});

test('Codex Code session service gates proxy on DEMO cache, not the Fast Mode button', () => {
  const service = readFileSync(
    // Domain folder name coincides with E2B template id env; allowlist for path join.
    join(process.cwd(), 'src', 'domains', 'codex-code', 'service.ts'), // pragma: allowlist secret
    'utf8'
  );
  const createSession = extractFunction(service, 'createSession');
  assert.ok(
    createSession.includes('agentFastMode'),
    'Codex Code createSession must resolve DEMO cache via agentFastMode'
  );
  assert.ok(
    createSession.includes('const fastModeCacheEnabled = fastMode.enabled'),
    'Codex Code createSession must use demo cache enabled for the proxy'
  );
  assert.ok(
    /createCodexCodeSession\([\s\S]*fastModeCacheEnabled[\s\S]*\)/.test(createSession),
    'Codex Code createSession must pass the demo cache flag into E2B env construction'
  );
});

test('#17-19 no cache kind for browser session / E2B sandbox / token', () => {
  const normalize = readFileSync(
    join(process.cwd(), 'src', 'providers', 'demoCacheNormalizeConstants.ts'),
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
process.stdout.write(`\n✅ demo-cache flag/invariants part2: ${passed}/${passed} passed\n`);
