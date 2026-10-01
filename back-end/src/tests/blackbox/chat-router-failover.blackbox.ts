#!/usr/bin/env tsx
/**
 * Exact-scenario regression: a chat follow-up must get a real turn when the
 * Cerebras router stalls and the turn is served by the OpenRouter failover.
 *
 * Prod agent e8f2279b-3ec9-4bd8-bbb4-d659b2e9cdf6 (2026-10-01). After a
 * completed hot-yoga run the user replied "wrong address, its the 88 howard
 * one" and got "Sorry — I couldn't generate a response just now."
 *
 *   POST message ─> routeUserMessage ─> handleChatMessage ─> callRouterLlm
 *     Cerebras: no content inside its 1.2s stall guard
 *     0.8s hedge ─> OpenRouter GLM / Qwen race; on this 24k-token context GLM
 *       needs up to ~3s (sometimes ~8s) before its first event, and the
 *       decision completes 4–19s after the turn starts
 *     GLM's 2s pre-token guard aborts it unless content arrives inside 2s, and
 *       the router's 3s whole-completion bound fired before any decision
 *       ─> deadline miss
 *     deadline misses were not regenerated ─> chat_handler_failure notice
 *
 * Every case drives the production entrypoint (`postMessage`) against the
 * local database, seeded with the agent's stored transcript. Its chat-model
 * projection is the 30-message router request prod logged; prod does not log
 * content, so the 88,440 chars are this projection of the stored rows
 * (fixtures/chat-router-failover-prod-e8f2279b.json; PII, including the
 * delivery street, replaced with same-length stand-ins). It replays provider
 * streams recorded on that request with their real timing
 * (fixtures/chat-router-failover-prod-e8f2279b-streams.json). Only the
 * network boundary is replaced; the Rose hedge, race, stall guards, router
 * bounds, regenerate, escalation, and Temporal acceptance all run for real
 * (Temporal through the in-memory blackbox client), under the bound defaults
 * prod runs with (inherited overrides are removed for the run).
 *
 * CHAT_ROUTER_FAILOVER_LIVE=1 adds the live probe: same seeded agent, a
 * Cerebras-wide outage (direct Cerebras and every other OpenRouter route
 * stalled), and the real OpenRouter GLM failover as the only path that can
 * serve. It must serve inside the first router attempt and reports which
 * OpenRouter host did. /deploy runs it in scripts/run_deploy_live_probes.py.
 */

import 'dotenv/config';
import './assertLocalDatabase';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from '../../providers/database';
import { postMessage } from '../../domains/agents/agentMessageService';
import { CHAT_HANDLER_FAILURE_NOTICE } from '../../providers/chat/chatHandlerFailure';
import { CLOUD_AGENT_TOOL_NAME } from '../../providers/chat/cloudAgentLifecycleTool';
import { DEFAULT_CHAT_ROUTER_STALL_TIMEOUT_MS } from '../../providers/chat/routerCompletionDeadline';
import { OPENROUTER_CEREBRAS_MODEL } from '../../providers/rose/openrouterCerebrasRoute';
import { OPENROUTER_FAST_CHAT_MODEL } from '../../providers/rose/openrouterFastRoute';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import { type LiveObservation, observedLiveFetch } from './chat-router-failover.live.support';

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.CHAT_ROUTER_FAILOVER_LIVE === '1';

/**
 * Every bound on this path that an env var can override. Render sets none of
 * them, so the test must run on the code defaults; a value inherited from a dev
 * or CI shell would prove a configuration prod does not run.
 */
const PROD_DEFAULT_BOUND_ENV = [
  'CEREBRAS_CHAT_IDLE_TIMEOUT_MS',
  'CEREBRAS_CHAT_HEDGE_MS',
  'OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS',
  'CHAT_ROUTER_STALL_TIMEOUT_MS',
  'CHAT_ROUTER_COMPLETION_TIMEOUT_MS',
] as const;

interface FixtureMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
  metadata: Record<string, unknown>;
}

interface RecordedEvent {
  dt: number;
  line: string;
}

const context = JSON.parse(
  readFileSync(join(here, '../fixtures/chat-router-failover-prod-e8f2279b.json'), 'utf8')
) as { agentId: string; messages: FixtureMessage[] };

const streams = JSON.parse(
  readFileSync(join(here, '../fixtures/chat-router-failover-prod-e8f2279b-streams.json'), 'utf8')
) as {
  cerebrasStall: RecordedEvent[];
  cerebrasHealthy: { events: RecordedEvent[] };
  openrouterGlm: { events: RecordedEvent[] };
};

const FOLLOW_UP = context.messages[context.messages.length - 1];
const PRIOR_MESSAGES = context.messages.slice(0, -1);
/** Router input the prod request carried: system prompt + 29 transcript turns. */
const PROD_ROUTER_MESSAGE_COUNT = 30;
const PROD_ROUTER_CONTENT_CHARS = 88_440;

// ── network boundary ─────────────────────────────────────────────────────────

type Behavior = 'stall' | 'healthy' | 'glm-recorded' | 'live';

/** Live requests also record the OpenRouter host that served, and when. */
interface ProviderRequest extends LiveObservation {
  provider: 'cerebras' | 'openrouter';
  model: string;
  schema: string;
  messageCount: number;
  contentChars: number;
  sessionId?: string;
  atMs: number;
}

interface Scenario {
  cerebras: (routerAttempt: number) => Behavior;
  glm: (routerAttempt: number) => Behavior;
  openrouterOther: Behavior;
}

/** Replays recorded SSE lines at their recorded offsets; optionally stays open. */
function replayResponse(
  events: RecordedEvent[],
  signal: AbortSignal | null | undefined,
  holdOpen: boolean
): Response {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (): void => {
        timers.forEach(clearTimeout);
        try {
          controller.error(signal?.reason ?? new Error('aborted'));
        } catch {
          // already closed
        }
      };
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener('abort', fail, { once: true });
      events.forEach((event, index) => {
        timers.push(
          setTimeout(() => {
            try {
              controller.enqueue(encoder.encode(`${event.line}\n\n`));
              if (index === events.length - 1 && !holdOpen) controller.close();
            } catch {
              // stream already errored by abort
            }
          }, event.dt)
        );
      });
    },
    cancel() {
      timers.forEach(clearTimeout);
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function contentChars(messages: Array<{ content?: unknown }>): number {
  return messages.reduce((total, message) => {
    if (typeof message.content === 'string') return total + message.content.length;
    if (Array.isArray(message.content)) {
      return (
        total +
        message.content.reduce(
          (sum: number, part: { text?: unknown }) =>
            sum + (typeof part.text === 'string' ? part.text.length : 0),
          0
        )
      );
    }
    return total;
  }, 0);
}

const ALERT_HOSTS = new Set(['slack.com', 'hooks.slack.com', 'api.github.com']);

function installNetwork(scenario: Scenario, startedAt: number) {
  const realFetch = globalThis.fetch;
  const requests: ProviderRequest[] = [];
  const unexpected: string[] = [];
  const alerts: string[] = [];
  let cerebrasRouterRequests = 0;
  let glmRouterRequests = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/realtime/v1/api/broadcast')) {
      return new Response('{}', { status: 202 });
    }
    if (ALERT_HOSTS.has(new URL(url).hostname)) {
      alerts.push(url);
      return new Response('{"ok":false}', { status: 503 });
    }
    if (url !== CEREBRAS_API_URL && url !== OPENROUTER_API_URL) {
      unexpected.push(url);
      throw new Error(`chat-router-failover: unexpected outbound ${url}`);
    }
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content?: unknown }>;
      response_format?: { json_schema?: { name?: string } };
      session_id?: string;
    };
    const schema = body.response_format?.json_schema?.name ?? '';
    const provider = url === CEREBRAS_API_URL ? 'cerebras' : 'openrouter';
    const request: ProviderRequest = {
      provider,
      model: body.model,
      schema,
      messageCount: body.messages.length,
      contentChars: contentChars(body.messages),
      sessionId: body.session_id,
      atMs: Date.now() - startedAt,
    };
    requests.push(request);
    const isRouter = schema === 'router_decision';
    let behavior: Behavior;
    if (provider === 'cerebras') {
      behavior = isRouter ? scenario.cerebras((cerebrasRouterRequests += 1)) : 'stall';
    } else if (body.model === OPENROUTER_FAST_CHAT_MODEL) {
      behavior = isRouter ? scenario.glm((glmRouterRequests += 1)) : scenario.openrouterOther;
    } else {
      behavior = scenario.openrouterOther;
    }
    const signal = init?.signal;
    switch (behavior) {
      case 'live':
        return observedLiveFetch(realFetch, input, init, request);
      case 'healthy':
        return replayResponse(streams.cerebrasHealthy.events, signal, false);
      case 'glm-recorded':
        return replayResponse(streams.openrouterGlm.events, signal, false);
      case 'stall':
        return replayResponse(provider === 'cerebras' ? streams.cerebrasStall : [], signal, true);
    }
  }) as typeof fetch;

  return {
    requests,
    unexpected,
    alerts,
    routerRequests: (provider: ProviderRequest['provider'], model?: string) =>
      requests.filter(
        (request) =>
          request.schema === 'router_decision' &&
          request.provider === provider &&
          (model === undefined || request.model === model)
      ),
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

// ── prod-shaped agent ────────────────────────────────────────────────────────

interface SeededAgent {
  userId: string;
  agentId: string;
}

async function seedProdAgent(): Promise<SeededAgent> {
  const userId = randomUUID();
  const agentId = randomUUID();
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: PRIOR_MESSAGES[0].text,
      title: 'Weekend Hot Yoga Class',
      status: 'COMPLETED',
      source: 'MAC_APP',
      model: 'rose-labs/rose-1-ultra',
      progress: 1,
      temporalWorkflowId: agentId,
      verifier: { create: {} },
    },
  });
  const base = Date.now() - PRIOR_MESSAGES.length * 1_000 - 60_000;
  await prisma.message.createMany({
    data: PRIOR_MESSAGES.map((message, index) => ({
      agentId,
      role: message.role,
      text: message.text,
      metadata: message.metadata as object,
      timestamp: new Date(base + index * 1_000),
    })),
  });
  return { userId, agentId };
}

async function cleanup(seeded: SeededAgent): Promise<void> {
  await prisma.toolUsage.deleteMany({ where: { agentId: seeded.agentId } });
  await prisma.agent.deleteMany({ where: { id: seeded.agentId } });
  await prisma.user.deleteMany({ where: { userId: seeded.userId } });
}

type Outcome =
  | { kind: 'escalated'; atMs: number; reasoning: string }
  | { kind: 'apology'; atMs: number }
  | { kind: 'timeout'; atMs: number };

async function waitForTurn(
  seeded: SeededAgent,
  since: Date,
  startedAt: number,
  timeoutMs: number
): Promise<Outcome> {
  const poll = async (): Promise<Outcome> => {
    const atMs = Date.now() - startedAt;
    const rows = await prisma.message.findMany({
      where: { agentId: seeded.agentId, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });
    if (rows.some((row) => row.role === 'ASSISTANT' && row.text === CHAT_HANDLER_FAILURE_NOTICE)) {
      return { kind: 'apology', atMs };
    }
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: seeded.agentId } });
    const cloudAgentTool = rows.find(
      (row) =>
        row.role === 'TOOL' &&
        (row.metadata as { toolName?: string } | null)?.toolName === CLOUD_AGENT_TOOL_NAME
    );
    if (agent.temporalWorkflowId !== null && agent.temporalFirstExecutionRunId && cloudAgentTool) {
      const reasoning = rows.find((row) => row.role === 'ASSISTANT')?.text ?? '';
      return { kind: 'escalated', atMs, reasoning };
    }
    if (atMs >= timeoutMs) return { kind: 'timeout', atMs };
    await new Promise((resolve) => setTimeout(resolve, 50));
    return poll();
  };
  return poll();
}

async function sendFollowUp(
  scenario: Scenario,
  timeoutMs: number
): Promise<{
  outcome: Outcome;
  network: ReturnType<typeof installNetwork>;
  seeded: SeededAgent;
  agent: { status: string; temporalWorkflowId: string | null };
}> {
  const seeded = await seedProdAgent();
  const since = new Date();
  const startedAt = Date.now();
  const network = installNetwork(scenario, startedAt);
  try {
    const posted = await postMessage(
      seeded.agentId,
      { message: FOLLOW_UP.text },
      false,
      seeded.userId
    );
    assert.ok(!('error' in posted), `postMessage failed: ${JSON.stringify(posted)}`);
    const outcome = await waitForTurn(seeded, since, startedAt, timeoutMs);
    // Let any losing provider branches observe their abort before restoring fetch.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const agent = await prisma.agent.findUniqueOrThrow({
      where: { id: seeded.agentId },
      select: { status: true, temporalWorkflowId: true },
    });
    return { outcome, network, seeded, agent };
  } finally {
    network.restore();
  }
}

function assertExactProdRouterContext(network: ReturnType<typeof installNetwork>): void {
  const [first] = network.routerRequests('cerebras');
  assert.ok(first, 'router must try direct Cerebras first');
  assert.equal(first.messageCount, PROD_ROUTER_MESSAGE_COUNT, 'router message count drifted');
  assert.equal(
    first.contentChars,
    PROD_ROUTER_CONTENT_CHARS,
    'router context must be the exact prod request (same-length PII scrub)'
  );
}

function assertNoStrayOutbound(network: ReturnType<typeof installNetwork>): void {
  assert.deepEqual(network.unexpected, [], 'chat turn reached an unexpected outbound host');
}

function assertHealthyTurn(network: ReturnType<typeof installNetwork>): void {
  assertNoStrayOutbound(network);
  assert.deepEqual(network.alerts, [], 'a served turn must not raise an error alert');
}

// ── cases ────────────────────────────────────────────────────────────────────

async function testExactProdFollowUpEscalatesThroughFailover(): Promise<void> {
  assert.ok(
    streams.openrouterGlm.events[0].dt > 2_000,
    'the recorded GLM failover must keep its >2s long-context first-event latency'
  );
  const { outcome, network, seeded, agent } = await sendFollowUp(
    { cerebras: () => 'stall', glm: () => 'glm-recorded', openrouterOther: 'stall' },
    40_000
  );
  try {
    assertExactProdRouterContext(network);
    assert.equal(
      outcome.kind,
      'escalated',
      `exact prod follow-up must escalate, got ${outcome.kind} after ${outcome.atMs}ms ` +
        `(Cerebras stalled; recorded GLM failover completes ~8.3s after the turn starts)`
    );
    assertHealthyTurn(network);
    assert.equal(network.routerRequests('cerebras').length, 1, 'no regenerate was needed');
    assert.equal(
      network.routerRequests('openrouter', OPENROUTER_FAST_CHAT_MODEL).length,
      1,
      'the decision came from the recorded GLM failover'
    );
    assert.ok(
      outcome.atMs > 3_000,
      `failover decision lands after the old 3s bound (${outcome.atMs}ms) — this is the path it killed`
    );
    assert.match(
      (outcome as { reasoning: string }).reasoning,
      /88 Harlow/,
      'router reasoning must carry the corrected address'
    );
    assert.equal(agent.status, 'ACTIVE');
    assert.equal(agent.temporalWorkflowId, seeded.agentId, 'Temporal accepted the re-plan');
    process.stdout.write(
      `  escalated at ${outcome.atMs}ms via ${OPENROUTER_FAST_CHAT_MODEL} (Cerebras stalled)\n`
    );
  } finally {
    await cleanup(seeded);
  }
}

async function testFirstStalledAttemptRegenerates(): Promise<void> {
  const { outcome, network, seeded } = await sendFollowUp(
    {
      cerebras: () => 'stall',
      glm: (attempt) => (attempt === 1 ? 'stall' : 'glm-recorded'),
      openrouterOther: 'stall',
    },
    45_000
  );
  try {
    assert.equal(
      outcome.kind,
      'escalated',
      `a fully stalled first router attempt must regenerate, got ${outcome.kind} after ${outcome.atMs}ms`
    );
    assertHealthyTurn(network);
    assert.equal(network.routerRequests('cerebras').length, 2, 'exactly one regenerate');
    const glm = network.routerRequests('openrouter', OPENROUTER_FAST_CHAT_MODEL);
    assert.equal(glm.length, 2, 'each router attempt raced its own GLM failover');
    assert.ok(
      glm.every((request) => request.sessionId),
      'every GLM failover must name its own OpenRouter session'
    );
    assert.notEqual(
      glm[0].sessionId,
      glm[1].sessionId,
      'the regenerate must not inherit the OpenRouter host pin of the stalled attempt'
    );
  } finally {
    await cleanup(seeded);
  }
}

async function testHealthyCerebrasPathUnchanged(): Promise<void> {
  const { outcome, network, seeded } = await sendFollowUp(
    { cerebras: () => 'healthy', glm: () => 'stall', openrouterOther: 'stall' },
    10_000
  );
  try {
    assertExactProdRouterContext(network);
    assert.equal(outcome.kind, 'escalated');
    assertHealthyTurn(network);
    assert.equal(network.routerRequests('cerebras').length, 1, 'no regenerate on a healthy turn');
    assert.equal(
      network.routerRequests('openrouter').length,
      0,
      'healthy Cerebras must not arm the OpenRouter hedge'
    );
    assert.ok(
      outcome.atMs < DEFAULT_CHAT_ROUTER_STALL_TIMEOUT_MS,
      `healthy router turn took ${outcome.atMs}ms — no router bound may be involved`
    );
    process.stdout.write(`  healthy Cerebras escalated at ${outcome.atMs}ms\n`);
  } finally {
    await cleanup(seeded);
  }
}

async function testExhaustedBudgetSurfacesOneNotice(): Promise<void> {
  const saved = {
    stall: process.env.CHAT_ROUTER_STALL_TIMEOUT_MS,
    completion: process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS,
  };
  process.env.CHAT_ROUTER_STALL_TIMEOUT_MS = '400';
  process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS = '400';
  try {
    const { outcome, network, seeded, agent } = await sendFollowUp(
      { cerebras: () => 'stall', glm: () => 'stall', openrouterOther: 'stall' },
      10_000
    );
    try {
      assert.equal(outcome.kind, 'apology', 'an exhausted budget still surfaces the notice');
      assertNoStrayOutbound(network);
      assert.equal(
        network.routerRequests('cerebras').length,
        2,
        'the first stalled attempt must regenerate before the notice'
      );
      const notices = await prisma.message.count({
        where: { agentId: seeded.agentId, text: CHAT_HANDLER_FAILURE_NOTICE },
      });
      assert.equal(notices, 1, 'exactly one notice');
      assert.ok(network.alerts.length > 0, 'an exhausted router budget is still alerted');
      assert.equal(agent.status, 'ACTIVE', 'a recoverable miss never fails the agent');
    } finally {
      await cleanup(seeded);
    }
  } finally {
    for (const [key, value] of [
      ['CHAT_ROUTER_STALL_TIMEOUT_MS', saved.stall],
      ['CHAT_ROUTER_COMPLETION_TIMEOUT_MS', saved.completion],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function testLiveFailoverEscalates(): Promise<void> {
  assert.ok(process.env.OPENROUTER_API_KEY, 'live probe requires OPENROUTER_API_KEY');
  const { outcome, network, seeded } = await sendFollowUp(
    { cerebras: () => 'stall', glm: () => 'live', openrouterOther: 'stall' },
    45_000
  );
  try {
    assertExactProdRouterContext(network);
    const attempts = network.routerRequests('cerebras').length;
    const glm = network.routerRequests('openrouter', OPENROUTER_FAST_CHAT_MODEL);
    const served = glm
      .map(
        (request, index) =>
          `attempt ${index + 1}: ${request.upstreamProvider ?? 'no host'}, HTTP ` +
          `${request.status ?? '-'} at ${request.headersMs ?? '-'}ms, first event ` +
          `${request.firstEventMs ?? '-'}ms, first content ${request.firstContentMs ?? '-'}ms`
      )
      .join('; ');
    process.stdout.write(`  live GLM failover: ${served}\n`);
    assert.equal(
      outcome.kind,
      'escalated',
      `live GLM failover must escalate the exact prod follow-up, got ${outcome.kind} after ` +
        `${outcome.atMs}ms over ${attempts} router attempt(s)`
    );
    assertHealthyTurn(network);
    assert.ok(
      network.routerRequests('openrouter', OPENROUTER_CEREBRAS_MODEL).length > 0,
      'the OpenRouter race must still start its Qwen branch (stalled here)'
    );
    assert.equal(glm.length, attempts, 'every router attempt must reach the real GLM failover');
    assert.equal(
      attempts,
      1,
      `the live GLM failover must serve inside the first router attempt's bounds (${served})`
    );
    process.stdout.write(
      `  live GLM failover escalated at ${outcome.atMs}ms via ${glm[0].upstreamProvider}\n`
    );
  } finally {
    await cleanup(seeded);
  }
}

// ── runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  assert.equal(FOLLOW_UP.role, 'USER');
  assert.equal(FOLLOW_UP.text, 'wrong address, its the 88 harlow one');
  process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND = '1';
  process.env.BLACKBOX_TEST_FAKE_TEMPORAL = '1';

  const savedKeys = {
    openrouter: process.env.OPENROUTER_API_KEY,
    cerebras: process.env.CEREBRAS_API_KEY,
  };
  process.env.CEREBRAS_API_KEY = 'blackbox-cerebras-key';
  if (!LIVE) process.env.OPENROUTER_API_KEY = 'blackbox-openrouter-key';
  const savedBounds = PROD_DEFAULT_BOUND_ENV.map((key) => [key, process.env[key]] as const);
  for (const [key, value] of savedBounds) {
    if (value === undefined) continue;
    process.stdout.write(`  ignoring inherited ${key}=${value}; prod runs the code default\n`);
    delete process.env[key];
  }

  const cases: Array<[string, () => Promise<void>]> = LIVE
    ? [
        [
          'live -- exact prod follow-up escalates through real OpenRouter',
          testLiveFailoverEscalates,
        ],
      ]
    : [
        [
          'exact prod follow-up escalates through the recorded GLM failover',
          testExactProdFollowUpEscalatesThroughFailover,
        ],
        ['a fully stalled first router attempt regenerates', testFirstStalledAttemptRegenerates],
        ['healthy Cerebras router path is unchanged', testHealthyCerebrasPathUnchanged],
        [
          'exhausted router budget surfaces exactly one notice',
          testExhaustedBudgetSurfacesOneNotice,
        ],
      ];

  let failed = 0;
  try {
    for (const [name, run] of cases) {
      const started = Date.now();
      try {
        await run();
        process.stdout.write(`PASS  ${name} (${Date.now() - started}ms)\n`);
      } catch (error) {
        failed += 1;
        process.stdout.write(
          `FAIL  ${name} (${Date.now() - started}ms)\n${error instanceof Error ? error.stack : String(error)}\n`
        );
      }
    }
  } finally {
    if (savedKeys.cerebras === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = savedKeys.cerebras;
    if (savedKeys.openrouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKeys.openrouter;
    for (const [key, value] of savedBounds) {
      if (value !== undefined) process.env[key] = value;
    }
    await prisma.$disconnect();
  }
  if (failed > 0) {
    process.stdout.write(`\n${failed}/${cases.length} chat-router-failover cases failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\nPASS chat-router-failover (${cases.length} cases)\n`);
  process.exit(0);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
