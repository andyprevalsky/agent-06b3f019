#!/usr/bin/env tsx
/**
 * Exact-scenario regression: a chat follow-up must get a real turn when the
 * Cerebras router stalls and the turn is served by the OpenRouter failover.
 *
 * Prod agent e8f2279b-3ec9-4bd8-bbb4-d659b2e9cdf6 (2026-10-01). After a
 * completed hot-yoga run the user replied "wrong address, its the 88 harlow
 * one" (fixture stand-in for their building) and got "Sorry — I couldn't
 * generate a response just now."
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
 * The router attempt and the GLM failover now get CHAT_TIMEOUT_MS (15s) from
 * the start of their attempt or request, and direct Cerebras gets 8s; the
 * 0.8s hedge only starts the failover early. Time to first content grows with
 * the context, so three cases replay the recorded streams at first-content
 * times measured on real prod router contexts: direct Cerebras past its old
 * 1.2s guard, GLM past the old 3s router attempt by more than 4s, and GLM's
 * slowest first content, which lands after the 8s guard has ended Cerebras.
 *
 * Every case drives the production entrypoint (`postMessage`) against the
 * local database, seeded with the agent's stored transcript. Its chat-model
 * projection is the 30-message router request prod logged; prod does not log
 * content, so the 82,649 transcript chars are this projection of the stored
 * rows (fixtures/chat-router-failover-prod-e8f2279b.json; PII, including the
 * delivery street, replaced with same-length stand-ins). It replays provider
 * streams recorded on that request with their real timing
 * (fixtures/chat-router-failover-prod-e8f2279b-streams.json). The network
 * boundary (chat-router-failover.network.support.ts) is replaced; the slowest
 * failover also holds only its fixture's postdecision persistence, separating
 * the measured router stream clock from durable turn completion. The
 * Rose hedge, race, stall guards, router bounds, regenerate, escalation, and
 * Temporal acceptance all run for real (Temporal through the in-memory
 * blackbox client), under the bound defaults prod runs with (inherited
 * overrides are removed for the run).
 *
 * CHAT_ROUTER_FAILOVER_LIVE=1 adds the live probe: same seeded agent, a
 * Cerebras-wide outage (direct Cerebras and every other OpenRouter route
 * stalled), and the real OpenRouter GLM failover as the only path that can
 * serve. It runs on the OpenRouter account back-end/.env configures, must
 * serve every router decision inside its first attempt with the corrected
 * address in the re-plan goal, and reports which host served. The router may
 * search before it escalates (bcee7f02c); those Parallel POSTs are answered
 * in-process with no results and close one decision round. A miss OpenRouter
 * caused is re-probed once a minute later; any other failure, or a second
 * miss, fails.
 * /deploy runs it in scripts/run_deploy_live_probes.py.
 */

import 'dotenv/config';
import './assertLocalDatabase';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from '../../providers/database';
import { quarantinedLiveFailoverCase } from './flake-quarantines.support';
import { postMessage } from '../../domains/agents/agentMessageService';
import { CHAT_HANDLER_FAILURE_NOTICE } from '../../providers/chat/chatHandlerFailure';
import { CLOUD_AGENT_TOOL_NAME } from '../../providers/chat/cloudAgentLifecycleTool';
import { DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS } from '../../providers/chat/routerCompletionDeadline';
import { DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS } from '../../providers/rose/cerebrasRoute';
import { DEFAULT_CEREBRAS_CHAT_HEDGE_MS } from '../../providers/rose/exclusiveCerebrasChatRoute';
import { OPENROUTER_CEREBRAS_MODEL } from '../../providers/rose/openrouterCerebrasRoute';
import { OPENROUTER_FAST_CHAT_MODEL } from '../../providers/rose/openrouterFastRoute';
import {
  assertProbesConfiguredOpenRouterAccount,
  assertServedOnFirstAttempt,
  describeLiveSample,
  type GoalAnchor,
  goalAnchorFailure,
  type LiveSample,
  liveSampleOf,
  probeLiveFailover,
  startedWorkflowGoal,
} from './chat-router-failover.live.support';
import {
  beginLiveEvidenceCapture,
  cleanupLiveEvidence,
  type LiveEvidenceCapture,
  type LiveSeededAgent as SeededAgent,
  recordLiveEvidenceSample,
  withEvidenceCleanup,
} from './chat-router-failover.evidence.support';
import {
  type FailoverNetwork,
  firstContentDt,
  installNetwork,
  observeRouterCompletion,
  LONG_CONTEXT_GLM_DELAY_MS,
  LONG_PREFILL_CEREBRAS_DELAY_MS,
  type Scenario,
  SLOWEST_GLM_DELAY_MS,
  streams,
} from './chat-router-failover.network.support';

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.CHAT_ROUTER_FAILOVER_LIVE === '1';

function warnTiming(condition: boolean, message: string): void {
  if (!condition) process.stderr.write(`timing warning: ${message}\n`);
}

/**
 * Every bound on this path that an env var can override. Render sets none of
 * them, so the test must run on the code defaults; a value inherited from a dev
 * or CI shell would prove a configuration prod does not run.
 */
const PROD_DEFAULT_BOUND_ENV = [
  'CEREBRAS_CHAT_IDLE_TIMEOUT_MS',
  'CEREBRAS_CHAT_HEDGE_MS',
  'OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS',
  'CHAT_ROUTER_COMPLETION_TIMEOUT_MS',
] as const;

interface FixtureMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
  metadata: Record<string, unknown>;
}

const context = JSON.parse(
  readFileSync(join(here, '../fixtures/chat-router-failover-prod-e8f2279b.json'), 'utf8')
) as { agentId: string; messages: FixtureMessage[] };

const FOLLOW_UP = context.messages[context.messages.length - 1];
const PRIOR_MESSAGES = context.messages.slice(0, -1);
/** The follow-up moves the run from the Irving, TX home anchor to 88 Harlow. */
const CORRECTED_GOAL: GoalAnchor = {
  corrected: /88 Harlow\b/,
  rejected: /(?:1000 )?Westward Oak|Irving|Las Colinas|Dallas|DFW|Texas|\b750\d\d\b/,
};
/**
 * Router input the prod request carried: system prompt + 29 transcript turns.
 * Only the transcript is pinned by size; the router system prompt is code and
 * changes with prompt edits.
 */
const PROD_ROUTER_MESSAGE_COUNT = 30;
const PROD_ROUTER_TRANSCRIPT_CHARS = 82_649;
/** A failover request starts at the hedge, so it has the router attempt's bound minus the hedge delay. */
const FAILOVER_PRE_CONTENT_BUDGET_MS =
  DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS - DEFAULT_CEREBRAS_CHAT_HEDGE_MS;
/** The FE chat lifecycle ratchet (front-end/tests-e2e/chat-lifecycle-latency.spec.ts). */
const HEALTHY_TURN_MS = 5_000;
/** OpenRouter-side misses on the e8f2279b profile came in a window of about a minute. */
const LIVE_REPROBE_DELAY_MS = 60_000;
/** Prod bounds that ended these turns: the router attempt and the Cerebras pre-content guard. */
const OLD_ROUTER_ATTEMPT_MS = 3_000;
const OLD_CEREBRAS_GUARD_MS = 1_200;

// ── prod-shaped agent ────────────────────────────────────────────────────────

async function seedProdAgent(evidence?: LiveEvidenceCapture): Promise<SeededAgent> {
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
  return { userId, agentId, evidence };
}

const cleanup = (seeded: SeededAgent): Promise<void> => cleanupLiveEvidence(prisma, seeded);

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
  timeoutMs: number,
  routerObservation?: 'measure' | 'hold-persistence',
  evidence?: LiveEvidenceCapture
): Promise<{
  outcome: Outcome;
  network: FailoverNetwork;
  seeded: SeededAgent;
  agent: { status: string; temporalWorkflowId: string | null };
  goal?: string;
  routerDurationMs?: number;
  turnElapsedMs: number;
}> {
  const seeded = await seedProdAgent(evidence);
  const since = new Date();
  const startedAt = Date.now();
  const network = installNetwork(scenario, startedAt);
  const router = routerObservation
    ? observeRouterCompletion(
        seeded.agentId,
        DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS,
        routerObservation === 'hold-persistence'
      )
    : undefined;
  let returned = false;
  return withEvidenceCleanup(
    async () => {
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
      const goal =
        outcome.kind === 'escalated' ? await startedWorkflowGoal(seeded.agentId) : undefined;
      const result = {
        outcome,
        network,
        seeded,
        agent,
        goal,
        routerDurationMs: router?.durationMs(),
        turnElapsedMs: Date.now() - startedAt,
      };
      returned = true;
      return result;
    },
    async () => {
      await router?.restore();
      network.restore();
      if (!returned) await cleanup(seeded);
    }
  );
}

function assertExactProdRouterContext(network: FailoverNetwork): void {
  const [first] = network.routerRequests('cerebras');
  assert.ok(first, 'router must try direct Cerebras first');
  assert.equal(
    first.messageCount,
    PROD_ROUTER_MESSAGE_COUNT + 1,
    'original router context plus one runtime clock'
  );
  assert.equal(
    first.transcriptChars - first.runtimeClock.length,
    PROD_ROUTER_TRANSCRIPT_CHARS,
    'router transcript must be the exact prod conversation (same-length PII scrub)'
  );
}

function assertNoStrayOutbound(network: FailoverNetwork): void {
  assert.deepEqual(network.unexpected, [], 'chat turn reached an unexpected outbound host');
}

function assertHealthyTurn(network: FailoverNetwork): void {
  assertNoStrayOutbound(network);
  assert.deepEqual(network.alerts, [], 'a served turn must not raise an error alert');
}

// ── cases ────────────────────────────────────────────────────────────────────

async function testExactProdFollowUpEscalatesThroughFailover(): Promise<void> {
  assert.ok(
    streams.openrouterGlm.events[0].dt > 2_000,
    'the recorded GLM failover must keep its >2s long-context first-event latency'
  );
  const { outcome, network, seeded, agent, goal } = await sendFollowUp(
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
    warnTiming(
      outcome.atMs > 3_000,
      `failover decision lands after the old 3s bound (${outcome.atMs}ms) — this is the path it killed`
    );
    assert.match(
      (outcome as { reasoning: string }).reasoning,
      /88 Harlow/,
      'router reasoning must carry the corrected address'
    );
    assert.equal(goalAnchorFailure(goal, CORRECTED_GOAL), undefined);
    assert.equal(agent.status, 'ACTIVE');
    assert.equal(agent.temporalWorkflowId, seeded.agentId, 'Temporal accepted the re-plan');
    process.stdout.write(
      `  escalated at ${outcome.atMs}ms via ${OPENROUTER_FAST_CHAT_MODEL} (Cerebras stalled)\n`
    );
  } finally {
    await cleanup(seeded);
  }
}

async function testLongContextFailoverServesOnFirstAttempt(): Promise<void> {
  const firstContentAt =
    DEFAULT_CEREBRAS_CHAT_HEDGE_MS +
    LONG_CONTEXT_GLM_DELAY_MS +
    firstContentDt(streams.openrouterGlm.events);
  assert.ok(
    firstContentAt > OLD_ROUTER_ATTEMPT_MS,
    `precondition: GLM's first content (${firstContentAt}ms) lands past the old ${OLD_ROUTER_ATTEMPT_MS}ms attempt`
  );
  const { outcome, network, seeded, goal, routerDurationMs, turnElapsedMs } = await sendFollowUp(
    { cerebras: () => 'stall', glm: () => 'glm-recorded-long-context', openrouterOther: 'stall' },
    40_000,
    'measure'
  );
  try {
    assertExactProdRouterContext(network);
    assert.equal(
      outcome.kind,
      'escalated',
      `a long-context failover must serve, got ${outcome.kind} after ${outcome.atMs}ms`
    );
    assertHealthyTurn(network);
    assert.equal(
      network.routerRequests('cerebras').length,
      1,
      'the first router attempt must serve it: no regenerate'
    );
    warnTiming(turnElapsedMs < 40_000, `persisted turn took ${turnElapsedMs}ms`);
    assert.ok(routerDurationMs !== undefined, 'actual router stream duration is required');
    warnTiming(
      routerDurationMs < DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS,
      `measured router stream took ${routerDurationMs}ms; persisted turn took ${turnElapsedMs}ms`
    );
    assert.equal(goalAnchorFailure(goal, CORRECTED_GOAL), undefined);
    process.stdout.write(
      `  GLM first content at ${firstContentAt}ms; escalated at ${outcome.atMs}ms on attempt 1\n`
    );
  } finally {
    await cleanup(seeded);
  }
}

async function testCerebrasGuardLeavesFailoverRacing(): Promise<void> {
  const firstContentAt =
    DEFAULT_CEREBRAS_CHAT_HEDGE_MS +
    SLOWEST_GLM_DELAY_MS +
    firstContentDt(streams.openrouterGlm.events);
  assert.ok(
    firstContentAt > DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS,
    `precondition: GLM's first content (${firstContentAt}ms) lands after the ${DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS}ms Cerebras guard`
  );
  const { outcome, network, seeded, goal, routerDurationMs, turnElapsedMs } = await sendFollowUp(
    { cerebras: () => 'stall', glm: () => 'glm-recorded-slowest', openrouterOther: 'stall' },
    40_000,
    'hold-persistence'
  );
  try {
    assert.equal(
      outcome.kind,
      'escalated',
      `the failover must outlive the Cerebras guard, got ${outcome.kind} after ${outcome.atMs}ms`
    );
    assertHealthyTurn(network);
    const cerebras = network.routerRequests('cerebras');
    assert.equal(cerebras.length, 1, 'the first router attempt must serve it: no regenerate');
    assert.match(
      cerebras[0].abortReason ?? '',
      new RegExp(`no model output within ${DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS}ms`),
      'direct Cerebras must be ended by its own guard'
    );
    assert.ok(
      (cerebras[0].abortedAtMs ?? Infinity) < firstContentAt,
      `Cerebras ended at ${cerebras[0].abortedAtMs}ms, before GLM's first content at ${firstContentAt}ms`
    );
    warnTiming(turnElapsedMs < 40_000, `persisted turn took ${turnElapsedMs}ms`);
    assert.ok(routerDurationMs !== undefined, 'actual router stream duration is required');
    warnTiming(
      routerDurationMs < DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS,
      `measured router stream took ${routerDurationMs}ms; persisted turn took ${turnElapsedMs}ms`
    );
    assert.equal(goalAnchorFailure(goal, CORRECTED_GOAL), undefined);
    process.stdout.write(
      `  Cerebras ended at ${cerebras[0].abortedAtMs}ms; GLM first content at ${firstContentAt}ms; ` +
        `router stream finished at ${routerDurationMs}ms; escalated at ${outcome.atMs}ms on attempt 1\n`
    );
  } finally {
    await cleanup(seeded);
  }
}

async function testLongPrefillCerebrasKeepsRacing(): Promise<void> {
  const firstContentAt =
    LONG_PREFILL_CEREBRAS_DELAY_MS + firstContentDt(streams.cerebrasHealthy.events);
  assert.ok(
    firstContentAt > OLD_CEREBRAS_GUARD_MS,
    `precondition: Cerebras's first content (${firstContentAt}ms) lands past its old ${OLD_CEREBRAS_GUARD_MS}ms guard`
  );
  const { outcome, network, seeded, goal } = await sendFollowUp(
    { cerebras: () => 'healthy-long-prefill', glm: () => 'stall', openrouterOther: 'stall' },
    30_000
  );
  try {
    assertExactProdRouterContext(network);
    assert.equal(
      outcome.kind,
      'escalated',
      `a long-prefill Cerebras response must serve, got ${outcome.kind} after ${outcome.atMs}ms`
    );
    assertHealthyTurn(network);
    assert.equal(network.routerRequests('cerebras').length, 1, 'no regenerate');
    assert.ok(
      network.routerRequests('openrouter', OPENROUTER_FAST_CHAT_MODEL).length > 0,
      'precondition: the hedge started the (stalled) failover while Cerebras was still silent'
    );
    assert.equal(goalAnchorFailure(goal, CORRECTED_GOAL), undefined);
    process.stdout.write(
      `  Cerebras first content at ${firstContentAt}ms; escalated at ${outcome.atMs}ms\n`
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
    warnTiming(
      outcome.atMs < HEALTHY_TURN_MS,
      `healthy router turn took ${outcome.atMs}ms, past the ${HEALTHY_TURN_MS}ms chat lifecycle ratchet`
    );
    process.stdout.write(`  healthy Cerebras escalated at ${outcome.atMs}ms\n`);
  } finally {
    await cleanup(seeded);
  }
}

async function testExhaustedBudgetSurfacesOneNotice(): Promise<void> {
  const saved = process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS;
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
    if (saved === undefined) delete process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS;
    else process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS = saved;
  }
}

async function runLiveSample(label: string): Promise<LiveSample> {
  const evidence = beginLiveEvidenceCapture(label);
  const { outcome, network, seeded, goal } = await sendFollowUp(
    { cerebras: () => 'stall', glm: () => 'live', openrouterOther: 'stall' },
    45_000,
    undefined,
    evidence
  );
  recordLiveEvidenceSample(evidence, { outcome, network, goal });
  return withEvidenceCleanup(
    async () => {
      assertExactProdRouterContext(network);
      assertNoStrayOutbound(network);
      assert.ok(
        network.routerRequests('openrouter', OPENROUTER_CEREBRAS_MODEL).length > 0,
        'the OpenRouter race must still start its Qwen branch (stalled here)'
      );
      const sample = liveSampleOf(network, { outcome, goal });
      process.stdout.write(describeLiveSample(label, sample) + network.describeSearches());
      if (goal !== undefined) process.stdout.write(`  escalation goal: ${goal}\n`);
      return sample;
    },
    () => cleanup(seeded),
    (sample) => assertServedOnFirstAttempt(sample, CORRECTED_GOAL)
  );
}

async function testLiveFailoverEscalates(): Promise<void> {
  const account = assertProbesConfiguredOpenRouterAccount(join(here, '../../../.env'));
  process.stdout.write(`  OpenRouter key ${account} (the account back-end/.env configures)\n`);
  await probeLiveFailover({
    runSample: runLiveSample,
    budgetMs: FAILOVER_PRE_CONTENT_BUDGET_MS,
    reprobeDelayMs: LIVE_REPROBE_DELAY_MS,
    goalAnchor: CORRECTED_GOAL,
  });
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
    ? [quarantinedLiveFailoverCase(testLiveFailoverEscalates)]
    : [
        [
          'exact prod follow-up escalates through the recorded GLM failover',
          testExactProdFollowUpEscalatesThroughFailover,
        ],
        [
          'long-context GLM failover serves on the first router attempt',
          testLongContextFailoverServesOnFirstAttempt,
        ],
        [
          'the GLM failover outlives the 8s direct-Cerebras guard',
          testCerebrasGuardLeavesFailoverRacing,
        ],
        [
          'long-prefill Cerebras keeps racing past its old 1.2s guard',
          testLongPrefillCerebrasKeepsRacing,
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
