#!/usr/bin/env tsx

/**
 * Multi-region Microsoft Foundry fallback (chat path), mirroring
 * agents/tests/unit/test_foundry_fallback.py. AZURE_FOUNDRY_* is region 1;
 * AZURE_FOUNDRY_*_2 and _3 add regions. A route key keeps a stable primary
 * region; pre-content 429s, in-stream rate limits, 5xx and transport errors try
 * the next region; every region cooling raises RoseRateLimitError.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createStreamingCompletion } from '../../providers/rose';
import {
  FOUNDRY_REGION_ENV_NAMES,
  __resetFoundryCooldowns,
  foundryComplete,
  foundryConfigured,
  foundryModels,
  foundryRegions,
  foundryRoutePlan,
} from '../../providers/rose/foundry';
import { RoseAuthError, RoseInvalidRequest, RoseRateLimitError } from '../../providers/rose/errors';
import { POOL_REGISTRY } from '../../providers/rose/pools';
import type { RoseStreamChunk } from '../../providers/rose/types';

const R1 = 'https://a-4989-resource.openai.azure.com';
const R2 = 'https://rose-eastus2.openai.azure.com';
const R3 = 'https://rose-swedencentral.openai.azure.com';
const KEYS: Record<string, string> = {
  [R1]: 'key-region-1',
  [R2]: 'key-region-2',
  [R3]: 'key-region-3',
};
const ULTRA = POOL_REGISTRY['rose-1-ultra'];

const sse = (...events: Array<Record<string, unknown>>): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
const ok = (): Response =>
  new Response(sse({ type: 'response.output_text.delta', delta: 'Hi' }), { status: 200 });

type Attempt = [region: string, deployment: string];
type Handler = (region: string, deployment: string) => Response | Promise<Response>;

function configure(handler: Handler, regions = [R1, R2, R3], deployments = 'gpt-6-sol'): Attempt[] {
  for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
  regions.forEach((endpoint, index) => {
    const suffix = index === 0 ? '' : `_${index + 1}`;
    process.env[`AZURE_FOUNDRY_ENDPOINT${suffix}`] = endpoint;
    process.env[`AZURE_FOUNDRY_API_KEY${suffix}`] = KEYS[endpoint];
    process.env[`AZURE_FOUNDRY_DEPLOYMENTS${suffix}`] = deployments;
  });
  __resetFoundryCooldowns();
  const attempts: Attempt[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const region = url.origin;
    if (!(region in KEYS)) {
      assert.equal(url.host, 'openrouter.ai', `unexpected provider ${url.host}`);
      attempts.push(['openrouter', '']);
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'OpenRouter' }, finish_reason: 'stop' }] })}\n\n` +
          'data: [DONE]\n\n',
        { status: 200 }
      );
    }
    assert.equal(url.pathname, '/openai/v1/responses');
    assert.equal((init?.headers as Record<string, string>)['api-key'], KEYS[region], 'own key');
    const deployment = String((JSON.parse(String(init?.body)) as { model: string }).model);
    attempts.push([region, deployment]);
    return handler(region, deployment);
  }) as typeof fetch;
  return attempts;
}

const planRegions = (routeKey: string, model = 'gpt-6-sol'): string[] =>
  foundryRoutePlan(foundryRegions(), model, routeKey).map(({ region }) => region.endpoint);

function keyWithPrimary(endpoint: string): string {
  for (let i = 0; i < 10_000; i++)
    if (planRegions(`agent-${i}`)[0] === endpoint) return `agent-${i}`;
  throw new Error(`no route key prefers ${endpoint}`);
}

async function drain(routeKey: string): Promise<RoseStreamChunk[]> {
  const chunks: RoseStreamChunk[] = [];
  for await (const chunk of foundryComplete({
    poolSpec: ULTRA,
    messages: [{ role: 'user', content: 'Say hi' }],
    effort: 'high',
    requestId: `region-${routeKey}`,
    routeKey,
  }))
    chunks.push(chunk);
  return chunks;
}

const text = (chunks: RoseStreamChunk[]): unknown =>
  chunks.find((chunk) => chunk.kind === 'content')?.data.text;

async function captureOutput<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let output = '';
  const capture = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    return { result: await run(), output };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const saved = [
    ...FOUNDRY_REGION_ENV_NAMES,
    'GPT_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
  ];
  const originalEnv = Object.fromEntries(saved.map((key) => [key, process.env[key]]));
  delete process.env.GPT_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.OPENROUTER_API_KEY = 'ork-test';
  try {
    // Region 1 429 → another region serves; region 1 then cools for this agent.
    let attempts = configure((region) =>
      region === R1
        ? new Response('', { status: 429, headers: { 'retry-after-ms': '5000' } })
        : ok()
    );
    let key = keyWithPrimary(R1);
    let chunks = await drain(key);
    assert.deepEqual(attempts, [
      [R1, 'gpt-6-sol'],
      [planRegions(key)[1], 'gpt-6-sol'],
    ]);
    assert.equal(text(chunks), 'Hi');
    assert.equal(chunks[0]?.data.actual_model, 'gpt-6-sol-foundry');
    attempts.length = 0;
    await drain(key);
    assert.deepEqual(attempts, [[planRegions(key)[1], 'gpt-6-sol']], 'cooling region skipped');
    process.stdout.write('Foundry regions: HTTP 429 fails over and cools that deployment\n');

    // Azure reports a deployment TPM ceiling inside an HTTP 200 stream.
    attempts = configure((region) =>
      region === R1
        ? new Response(
            sse({
              type: 'response.failed',
              response: { error: { code: 'rate_limit_exceeded', message: 'token rate limit' } },
            }),
            { status: 200 }
          )
        : ok()
    );
    key = keyWithPrimary(R1);
    chunks = await drain(key);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.[0], R1);
    assert.notEqual(attempts[1]?.[0], R1);
    assert.equal(text(chunks), 'Hi');
    attempts.length = 0;
    await drain(key);
    assert.notEqual(attempts[0]?.[0], R1, 'in-stream rate limit cools the region deployment');
    process.stdout.write('Foundry regions: in-stream rate limit fails over\n');

    // Every region rate limited → RoseRateLimitError; while cooling, no request at all.
    attempts = configure(() => new Response('', { status: 429, headers: { 'retry-after': '30' } }));
    await assert.rejects(drain('agent-saturated'), RoseRateLimitError);
    assert.deepEqual(attempts.map(([region]) => region).sort(), [R1, R2, R3].sort());
    attempts.length = 0;
    await assert.rejects(drain('agent-other'), RoseRateLimitError);
    assert.deepEqual(attempts, [], 'cooling regions are not probed');
    process.stdout.write('Foundry regions: all cooling raises RoseRateLimitError\n');

    // Visible output is never spliced with another region.
    attempts = configure(
      () =>
        new Response(
          sse(
            { type: 'response.output_text.delta', delta: 'Partial' },
            { type: 'response.failed', error: { code: 'rate_limit_exceeded', message: 'late' } }
          ),
          { status: 200 }
        )
    );
    await assert.rejects(drain('agent-partial'), RoseRateLimitError);
    assert.equal(attempts.length, 1);
    process.stdout.write('Foundry regions: post-content failure never fails over\n');

    // 5xx and transport failures try the next region without a cooldown.
    key = 'agent-server-errors';
    attempts = configure((region) => {
      const order = planRegions(key);
      if (region === order[0]) return new Response('', { status: 503 });
      if (region === order[1]) throw new TypeError('fetch failed');
      return ok();
    });
    assert.equal(text(await drain(key)), 'Hi');
    assert.deepEqual(
      attempts.map(([region]) => region),
      planRegions(key)
    );
    attempts.length = 0;
    await drain(key);
    assert.deepEqual(
      attempts.map(([region]) => region),
      planRegions(key),
      'transient 5xx/transport errors do not cool a deployment'
    );
    process.stdout.write('Foundry regions: 5xx and transport errors fail over\n');

    // A request-shape rejection is the same everywhere: stop after one region.
    for (const response of [
      () => new Response('', { status: 400 }),
      () =>
        new Response(
          sse({ type: 'error', error: { code: 'context_length_exceeded', message: 'too long' } }),
          { status: 200 }
        ),
    ]) {
      attempts = configure(response);
      await assert.rejects(drain('agent-bad-request'), RoseInvalidRequest);
      assert.equal(attempts.length, 1);
    }
    process.stdout.write('Foundry regions: request-shape errors stop every region\n');

    // A region's key failure cools only that region.
    attempts = configure((region) => (region === R2 ? new Response('', { status: 401 }) : ok()));
    key = keyWithPrimary(R2);
    assert.equal(text(await drain(key)), 'Hi');
    assert.equal(attempts[0]?.[0], R2);
    assert(foundryConfigured(ULTRA), 'other regions stay configured');
    attempts.length = 0;
    await drain(key);
    assert(attempts.every(([region]) => region !== R2));
    attempts = configure(() => new Response('', { status: 403 }), [R1]);
    await assert.rejects(drain('agent-auth'), RoseAuthError);
    assert.equal(attempts.length, 1);
    assert(!foundryConfigured(ULTRA), 'single region auth failure still disables Foundry');
    process.stdout.write('Foundry regions: auth failure cools only that region\n');

    // Stable primary per route key, balanced primaries, overflow spread evenly,
    // and adding a region moves only the agents it takes over.
    configure(ok);
    const keys = Array.from({ length: 3000 }, (_, i) => `agent-${i}`);
    const plans = new Map(keys.map((routeKey) => [routeKey, planRegions(routeKey)]));
    for (const routeKey of keys.slice(0, 200))
      assert.deepEqual(planRegions(routeKey), plans.get(routeKey));
    for (const region of [R1, R2, R3]) {
      const primary = keys.filter((routeKey) => plans.get(routeKey)?.[0] === region);
      const share = primary.length / keys.length;
      assert(share > 0.28 && share < 0.39, `${region} primary share ${share}`);
      for (const other of [R1, R2, R3].filter((candidate) => candidate !== region)) {
        const next =
          primary.filter((routeKey) => plans.get(routeKey)?.[1] === other).length / primary.length;
        assert(next > 0.4 && next < 0.6, `${region} overflow to ${other}: ${next}`);
      }
    }
    delete process.env.AZURE_FOUNDRY_ENDPOINT_3;
    const before = new Map(keys.map((routeKey) => [routeKey, planRegions(routeKey)[0]]));
    process.env.AZURE_FOUNDRY_ENDPOINT_3 = R3;
    for (const routeKey of keys)
      if (plans.get(routeKey)?.[0] !== before.get(routeKey))
        assert.equal(plans.get(routeKey)?.[0], R3);
    process.stdout.write('Foundry regions: stable, balanced rendezvous order\n');

    // Single-region config: exactly the previous deployment rotation.
    configure(ok, [R1]);
    process.env.AZURE_FOUNDRY_ENDPOINT = `${R1}/openai/v1/`;
    process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol,gpt-6-sol-b,gpt-6-sol-c';
    const [only] = foundryRegions();
    assert.deepEqual([foundryRegions().length, only?.slot, only?.endpoint], [1, 1, R1]);
    const names = ['gpt-6-sol', 'gpt-6-sol-b', 'gpt-6-sol-c'];
    for (let i = 0; i < 200; i++) {
      const routeKey = `agent-${i}`;
      const start =
        parseInt(createHash('sha256').update(routeKey).digest('hex').slice(0, 8), 16) %
        names.length;
      assert.deepEqual(
        foundryRoutePlan(foundryRegions(), 'gpt-6-sol', routeKey).map(({ region, deployment }) => [
          region.endpoint,
          deployment,
        ]),
        [...names.slice(start), ...names.slice(0, start)].map((name) => [R1, name])
      );
    }
    process.stdout.write('Foundry regions: single-region plan unchanged\n');

    // A new resource holding only Sol never receives Luna/other-pool traffic.
    configure(ok);
    for (const routeKey of ['agent-1', 'agent-2', 'agent-3'])
      assert.deepEqual(planRegions(routeKey, 'gpt-5.6-luna'), [R1]);
    delete process.env.AZURE_FOUNDRY_ENDPOINT;
    delete process.env.AZURE_FOUNDRY_API_KEY;
    assert(foundryConfigured(ULTRA));
    assert(!foundryConfigured(POOL_REGISTRY['rose-1-mini']));
    delete process.env.AZURE_FOUNDRY_API_KEY_2;
    assert.deepEqual(
      foundryRegions().map((region) => region.slot),
      [3],
      'an incomplete region is not a region'
    );
    process.stdout.write('Foundry regions: secondary regions serve only listed models\n');

    // A model listed only by another region never routes to region 1, whose
    // deploymentless call for it is a terminal 400.
    configure(ok, [R1, R2]);
    process.env.AZURE_FOUNDRY_DEPLOYMENTS_2 = 'gpt-6.1-sol';
    for (let i = 0; i < 200; i++) {
      assert.deepEqual(planRegions(`agent-${i}`, 'gpt-6.1-sol'), [R2]);
      assert.deepEqual(planRegions(`agent-${i}`, 'gpt-5.6-luna'), [R1]);
    }
    process.env.AZURE_FOUNDRY_DEPLOYMENTS_2 = 'gpt-6-sol';
    assert.deepEqual(
      planRegions('agent-1', 'gpt-6.1-sol'),
      [R1],
      'unlisted: deploymentless region 1'
    );
    process.stdout.write('Foundry regions: a model listed elsewhere skips region 1\n');

    // GPT-6 Sol and GPT-6.1 Sol stand in for each other: ultra may use either.
    configure(ok, [R1, R2]);
    process.env.AZURE_FOUNDRY_DEPLOYMENTS_2 = 'gpt-6.1-sol';
    const ultraModels = foundryModels(ULTRA);
    assert.deepEqual(ultraModels, ['gpt-6-sol', 'gpt-6.1-sol']);
    assert.deepEqual(foundryModels(POOL_REGISTRY['rose-1-flash']), ['gpt-5.6-luna']);
    let r2First = 0;
    let r1FirstKey = '';
    for (let i = 0; i < 200; i++) {
      const plan = foundryRoutePlan(foundryRegions(), ultraModels, `agent-${i}`);
      assert.deepEqual(
        plan.map(({ region, deployment }) => `${region.endpoint} ${deployment}`).sort(),
        [`${R1} gpt-6-sol`, `${R2} gpt-6.1-sol`]
      );
      if (plan[0]?.region.endpoint === R2) r2First++;
      else r1FirstKey ||= `agent-${i}`;
    }
    assert(r2First > 70 && r2First < 130, `ultra spreads over both Sol regions (${r2First}/200)`);
    attempts = configure(
      (region) =>
        region === R1 ? new Response('', { status: 429, headers: { 'retry-after': '5' } }) : ok(),
      [R1, R2]
    );
    process.env.AZURE_FOUNDRY_DEPLOYMENTS_2 = 'gpt-6.1-sol';
    const solChunks = await drain(r1FirstKey);
    assert.deepEqual(attempts, [
      [R1, 'gpt-6-sol'],
      [R2, 'gpt-6.1-sol'],
    ]);
    assert.equal(
      solChunks[0]?.data.actual_model,
      'gpt-6.1-sol-foundry',
      'reports the served model'
    );
    process.stdout.write('Foundry regions: ultra fails over between Sol versions\n');

    // A non-HTTPS optional region is dropped (one warning naming its slot); the
    // healthy regions keep serving and foundryConfigured agrees with routing.
    attempts = configure(() => ok(), [R1, R2]);
    process.env.AZURE_FOUNDRY_ENDPOINT_7 = 'http://typo-region.openai.azure.com';
    process.env.AZURE_FOUNDRY_API_KEY_7 = 'key-region-7';
    process.env.AZURE_FOUNDRY_DEPLOYMENTS_7 = 'gpt-6-sol';
    {
      const { result, output } = await captureOutput(async () => {
        const configured = foundryConfigured(ULTRA);
        const served = text(await drain('agent-insecure-optional'));
        await drain('agent-insecure-optional-2');
        return { configured, served };
      });
      assert.equal(result.configured, true);
      assert.equal(result.served, 'Hi');
      assert.equal(output.split('foundry.region_not_https').length - 1, 1, output);
      assert(output.includes('AZURE_FOUNDRY_ENDPOINT_7'), output);
      assert(
        attempts.every(([region]) => region === R1 || region === R2),
        String(attempts)
      );
    }
    // Only the insecure optional region lists Ultra's model: Foundry is not configured.
    configure(() => ok(), [R1, R2], 'gpt-5.6-luna');
    delete process.env.AZURE_FOUNDRY_ENDPOINT;
    delete process.env.AZURE_FOUNDRY_API_KEY;
    process.env.AZURE_FOUNDRY_ENDPOINT_3 = 'http://typo-region.openai.azure.com';
    process.env.AZURE_FOUNDRY_API_KEY_3 = 'key-region-3';
    process.env.AZURE_FOUNDRY_DEPLOYMENTS_3 = 'gpt-6-sol';
    await captureOutput(async () =>
      assert.equal(foundryConfigured(ULTRA), false, 'routing would never use slot 3')
    );
    // No HTTPS region left at all: the configuration is rejected.
    delete process.env.AZURE_FOUNDRY_ENDPOINT_2;
    await assert.rejects(
      captureOutput(() => drain('agent-only-insecure')),
      (error: unknown) =>
        error instanceof RoseInvalidRequest &&
        /AZURE_FOUNDRY_ENDPOINT_3 must be HTTPS/.test(error.message)
    );
    // A non-HTTPS region 1 still rejects the whole configuration.
    attempts = configure(() => ok(), [R1, R2]);
    process.env.AZURE_FOUNDRY_ENDPOINT = 'http://a-4989-resource.openai.azure.com';
    assert.equal(foundryConfigured(ULTRA), true, 'routing surfaces the config error');
    await assert.rejects(
      drain('agent-insecure-primary'),
      (error: unknown) =>
        error instanceof RoseInvalidRequest &&
        /AZURE_FOUNDRY_ENDPOINT must be HTTPS/.test(error.message)
    );
    assert.deepEqual(attempts, []);
    process.stdout.write(
      'Foundry regions: non-HTTPS optional region is skipped, primary rejects\n'
    );

    // Logs name the region and deployment that failed and served; never a key.
    attempts = configure((region) => {
      if (region === R1)
        return new Response('', { status: 429, headers: { 'retry-after-ms': '1000' } });
      if (region === R2) return new Response('', { status: 401 });
      return ok();
    });
    key = '';
    for (let i = 0; i < 10_000 && !key; i++)
      if (planRegions(`agent-${i}`).join() === [R1, R2, R3].join()) key = `agent-${i}`;
    const { output } = await captureOutput(() => drain(key));
    assert.deepEqual(
      attempts.map(([region]) => region),
      [R1, R2, R3]
    );
    // Format-agnostic: dev logs print key=value, production logs print JSON.
    const logged = (event: string, ...fields: Array<[string, string | number]>): boolean =>
      output
        .split('\n')
        .some(
          (line) =>
            line.includes(event) &&
            fields.every(
              ([name, value]) =>
                line.includes(`${name}=${value}`) ||
                line.includes(`"${name}":${JSON.stringify(value)}`)
            )
        );
    const sol: [string, string] = ['deployment', 'gpt-6-sol'];
    assert(
      logged(
        'foundry.attempt_failed',
        ['region', 'a-4989-resource.openai.azure.com'],
        ['region_slot', 1],
        sol,
        ['status', 429]
      )
    );
    assert(
      logged(
        'foundry.attempt_failed',
        ['region', 'rose-eastus2.openai.azure.com'],
        ['region_slot', 2],
        sol,
        ['status', 401]
      )
    );
    assert(
      logged(
        'foundry.served',
        ['region', 'rose-swedencentral.openai.azure.com'],
        ['region_slot', 3],
        sol,
        ['attempt', 3]
      )
    );
    const rendered = `${output}${JSON.stringify(foundryRegions())}${String(foundryRegions())}`;
    for (const secret of Object.values(KEYS)) assert(!rendered.includes(secret), 'key leaked');
    process.stdout.write('Foundry regions: region evidence logged, keys never\n');

    // Through the public chat client: a rate-limited region hands Ultra to another
    // region; only when every region cools does OpenRouter serve.
    const limited = new Set<string>();
    attempts = configure((region) =>
      limited.has(region)
        ? new Response('', { status: 429, headers: { 'retry-after': '30' } })
        : ok()
    );
    key = 'agent-client-regions';
    const order = planRegions(key);
    limited.add(order[0] as string);
    const collect = async (): Promise<unknown[]> => {
      const out: unknown[] = [];
      const stream = await createStreamingCompletion({
        model: 'rose-labs/rose-1-ultra',
        messages: [{ role: 'user', content: 'Say hi' }],
        route_key: key,
      });
      for await (const chunk of stream)
        out.push(chunk.choices[0]?.delta.content ?? chunk.actual_model);
      return out;
    };
    let served = await collect();
    assert.deepEqual(
      attempts.map(([region]) => region),
      order.slice(0, 2)
    );
    assert(served.includes('Hi') && served.includes('gpt-6-sol-foundry'));
    attempts.length = 0;
    for (const region of order) limited.add(region);
    served = await collect();
    assert.deepEqual(
      attempts.map(([region]) => region),
      [...order.slice(1), 'openrouter']
    );
    assert(served.includes('OpenRouter'));
    process.stdout.write('Foundry regions: client fails over regions before OpenRouter\n');
  } finally {
    globalThis.fetch = originalFetch;
    __resetFoundryCooldowns();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
