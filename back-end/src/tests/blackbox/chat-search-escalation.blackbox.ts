#!/usr/bin/env tsx
/**
 * Exact-scenario regression: a chat turn whose web search does not find what
 * the user asked for keeps searching or escalates to the Cloud Agent; it never
 * ends in a "nothing came up" reply. Searches can fan out into parallel queries.
 *
 * Prod agent 572da2a5-4fc0-45f4-b9a7-d20b08e19a4e (2026-10-12, MAC_APP). Twice
 * the user described a manga by its plot. Each time chat ran one web search,
 * got unrelated titles, and the Generator, the only step after the search,
 * replied that nothing matched and asked a question. The user escalated the
 * first turn by hand and the Cloud Agent named the title (Uwasa no Midori-kun).
 *
 *   postMessage ─> handleChatMessage ─> Router ─> web_search (1+ parallel queries)
 *     before: ─> Generator ─> "nothing came up" reply; no search again, no escalation
 *     after:  ─> Router again ─┬─ web_search ─> next round (up to MAX_CHAT_SEARCH_ROUNDS)
 *                              ├─ start_superintelligence ─> Cloud Agent (Temporal)
 *                              └─ direct_answer ─> Generator that overlapped the route
 *             after the last round the Router can only answer or escalate
 *
 * Every case drives the production entrypoint (`postMessage`) against the
 * local database. The follow-up case seeds the agent's real turn-1 history,
 * including the clarifying question chat asked then. The network boundary
 * serves recordings keyed by the exact request: completions by the sha256 of
 * the provider request body, searches by query. The prod search query is
 * served the prod results (reconstructed byte-for-byte from the prod TOOL
 * row). The follow-up pins that same historical no-match snapshot for every
 * query, explicitly modeling unavailable search evidence. Other queries use
 * Parallel; every completed model response is recorded live from qwen-3.8-27b.
 * A prompt, schema or context change produces an unrecorded request and fails
 * the replay instead of replaying a stale answer. The Router, Rose client,
 * search loop, escalation and Temporal acceptance (in-memory client) run for real.
 *
 * CHAT_SEARCH_ESCALATION_RECORD=1 records the current code's requests live
 * through back-end/.env's providers with the fixture's controlled UTC clock.
 * It is not a deploy probe.
 */

import 'dotenv/config';
import './assertLocalDatabase';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withCurrentTimeContext } from '../../providers/currentTimeContext';
import { prisma } from '../../providers/database';
import { postMessage } from '../../domains/agents/agentMessageService';
import { CHAT_HANDLER_FAILURE_NOTICE } from '../../providers/chat/chatHandlerFailure';
import { CLOUD_AGENT_TOOL_NAME } from '../../providers/chat/cloudAgentLifecycleTool';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import { startedWorkflowGoal } from './chat-router-failover.live.support';
import {
  recordLiveCall,
  replayCall,
  settleRecordings,
  stalledResponse,
  type RecordedCall,
} from './chat-search-escalation.network.support';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, '../fixtures/chat-search-escalation-prod-572da2a5.json');
const RECORD = process.env.CHAT_SEARCH_ESCALATION_RECORD === '1';
const PARALLEL_SEARCH_URL = 'https://api.parallel.ai/v1/search';
const CHAT_MODEL = 'qwen-3.8-27b';
const TURN_TIMEOUT_MS = 30_000;

type ScenarioName = 'firstTurn' | 'followUpTurn' | 'multiPartQuestion';

interface SearchResult {
  title: string;
  url: string;
  excerpts: string[];
}

interface SeedMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
  metadata: Record<string, unknown>;
}

interface Scenario {
  /** Search evidence policy, independent of the real Router's decisions. */
  searchPolicy: {
    mode: 'live' | 'pinned_snapshot';
    source: string;
    purpose: string;
  };
  priorMessages: SeedMessage[];
  userMessage: string;
  /** The prod search this turn ran; its query is always served these results. */
  prodSearch: { query: string; toolText: string; results: SearchResult[] } | null;
  /** The prod Generator reply to exactly `prodSearch` (the pre-fix path). */
  prodGeneratorContent: string | null;
}

interface Fixture {
  agentId: string;
  recordedAt: string;
  /** Controlled instant sent to the provider when these calls were recorded. */
  clockInstant: string;
  note: string;
  scenarios: Record<ScenarioName, Scenario>;
  searches: Record<string, { results: SearchResult[] }>;
  calls: Record<string, RecordedCall>;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

// ── network boundary ─────────────────────────────────────────────────────────

/** Speculative Generator started with the first route, before any search result. */
type RequestKind = 'router' | 'generator' | 'generator_before_search';

interface ProviderRequest {
  kind: RequestKind;
  provider: 'cerebras' | 'openrouter';
  fingerprint: string;
  startedAtMs: number;
  finishedAtMs?: number;
  actionEnum?: string[];
  messages: Array<{ role?: string; content?: unknown }>;
}

interface RequestBody {
  messages: Array<{ role?: string; content?: unknown }>;
  response_format?: {
    json_schema?: {
      name?: string;
      schema?: { properties?: { action?: { enum?: string[] } } };
    };
  };
}

/** Transport framing and per-request ids; everything else is what the model saw. */
const UNFINGERPRINTED_FIELDS = new Set(['stream', 'stream_options', 'session_id']);

function fingerprint(body: RequestBody): string {
  const fields = Object.entries(body as unknown as Record<string, unknown>)
    .filter(([field]) => !UNFINGERPRINTED_FIELDS.has(field))
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/** Validate the entire runtime reminder before normalizing only its dynamic clock. */
function controlledClockBody(body: RequestBody): RequestBody {
  const reminder = body.messages.at(-1);
  assert.equal(reminder?.role, 'user', 'runtime clock must remain a trailing user message');
  assert.equal(typeof reminder.content, 'string');
  const match = (reminder.content as string).match(/Current UTC time: ([^\n]+)/);
  assert.ok(match, 'runtime reminder must contain its UTC instant');
  const instant = new Date(match[1]);
  assert.ok(Number.isFinite(instant.getTime()), 'runtime clock instant must parse');
  const expected = JSON.parse(JSON.stringify(withCurrentTimeContext([], instant)[0]));
  assert.deepEqual(reminder, expected, 'runtime reminder must exactly match the production helper');
  assert.ok(Number.isFinite(new Date(fixture.clockInstant).getTime()), 'fixture clock is explicit');
  const controlled = withCurrentTimeContext([], new Date(fixture.clockInstant))[0];
  return { ...body, messages: [...body.messages.slice(0, -1), controlled] };
}

/** The runtime reminder follows the task/tool tail and is not itself task context. */
function lastContent(body: Pick<RequestBody, 'messages'>): string {
  const content = body.messages.at(-2)?.content;
  return typeof content === 'string' ? content : '';
}

function classify(body: RequestBody): { kind: RequestKind; actionEnum?: string[] } | null {
  const format = body.response_format?.json_schema;
  if (format?.name === 'generator_response') {
    // This turn's search results are the newest messages; older turns can hold others.
    return {
      kind: lastContent(body).startsWith('[Tool Result]') ? 'generator' : 'generator_before_search',
    };
  }
  if (format?.name !== 'router_decision') return null;
  return { kind: 'router', actionEnum: format.schema?.properties?.action?.enum ?? [] };
}

function installNetwork(scenario: Scenario, startedAt: number) {
  const realFetch = globalThis.fetch;
  const requests: ProviderRequest[] = [];
  const searched: string[] = [];
  const servedSnapshots: Array<{ query: string; results: SearchResult[] }> = [];
  const unexpected: string[] = [];
  const unrecorded: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/realtime/v1/api/broadcast')) {
      return new Response('{}', { status: 202 });
    }
    if (url === PARALLEL_SEARCH_URL) {
      const query = (JSON.parse(String(init?.body)) as { objective: string }).objective;
      searched.push(query);
      if (scenario.searchPolicy.mode === 'pinned_snapshot') {
        assert.ok(
          scenario.prodSearch,
          'a pinned search environment requires its production snapshot'
        );
        const results = scenario.prodSearch.results;
        servedSnapshots.push({ query, results });
        return Response.json({ results });
      }
      const prod = scenario.prodSearch?.query === query ? scenario.prodSearch : null;
      const recorded = prod ? { results: prod.results } : fixture.searches[query];
      if (recorded && (!RECORD || prod)) {
        if (RECORD) fixture.searches[query] = recorded;
        return Response.json(recorded);
      }
      if (!RECORD) {
        unrecorded.push(`search: ${query}`);
        return new Response('{"error":"unrecorded search"}', { status: 400 });
      }
      const response = await realFetch(input, init);
      const data = (await response.clone().json()) as { results: SearchResult[] };
      fixture.searches[query] = {
        results: data.results.map(({ title, url: resultUrl, excerpts }) => ({
          title,
          url: resultUrl,
          excerpts,
        })),
      };
      return response;
    }
    if (url !== CEREBRAS_API_URL && url !== OPENROUTER_API_URL) {
      unexpected.push(url);
      throw new Error(`chat-search-escalation: unexpected outbound ${url}`);
    }
    const body = controlledClockBody(JSON.parse(String(init?.body)) as RequestBody);
    const classified = classify(body);
    if (!classified) {
      unexpected.push(`${url} (unclassified completion)`);
      throw new Error(`chat-search-escalation: unclassified completion to ${url}`);
    }
    const request: ProviderRequest = {
      kind: classified.kind,
      provider: url === CEREBRAS_API_URL ? 'cerebras' : 'openrouter',
      fingerprint: fingerprint(body),
      startedAtMs: Date.now() - startedAt,
      actionEnum: classified.actionEnum,
      messages: body.messages,
    };
    requests.push(request);
    // Hedge legs and the pre-search speculation never carry the turn.
    if (request.provider === 'openrouter' || request.kind === 'generator_before_search') {
      return stalledResponse(init?.signal);
    }
    const finished = () => {
      request.finishedAtMs = Date.now() - startedAt;
    };
    if (RECORD) {
      // Discarded speculation never completes; record that it was asked.
      fixture.calls[request.fingerprint] = { kind: request.kind, model: CHAT_MODEL, content: null };
      return recordLiveCall(realFetch, input, { ...init, body: JSON.stringify(body) }, (call) => {
        finished();
        assert.equal(call.model, CHAT_MODEL, `${request.kind} must be served by ${CHAT_MODEL}`);
        fixture.calls[request.fingerprint] = { kind: request.kind, ...call };
      });
    }
    const recorded = fixture.calls[request.fingerprint];
    if (!recorded) {
      unrecorded.push(`${request.kind}: ${request.fingerprint}`);
      return new Response('{"error":"unrecorded request"}', { status: 400 });
    }
    if (recorded.content === null) return stalledResponse(init?.signal);
    return replayCall({ model: recorded.model, content: recorded.content }, init?.signal, finished);
  }) as typeof fetch;

  return {
    requests,
    searched,
    servedSnapshots,
    unexpected,
    unrecorded,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

type Network = ReturnType<typeof installNetwork>;

// ── prod-shaped agent ────────────────────────────────────────────────────────

interface SeededAgent {
  userId: string;
  agentId: string;
}

/** A fresh MAC_APP chat agent, or one whose earlier turns finished. */
async function seedChatAgent(scenario: Scenario): Promise<SeededAgent> {
  const userId = randomUUID();
  const agentId = randomUUID();
  const hasHistory = scenario.priorMessages.length > 0;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: hasHistory ? scenario.priorMessages[0].text : scenario.userMessage,
      status: hasHistory ? 'COMPLETED' : 'ACTIVE',
      source: 'MAC_APP',
      model: 'rose-labs/rose-1-ultra',
      ...(hasHistory ? { progress: 1, temporalWorkflowId: agentId } : {}),
      verifier: { create: {} },
    },
  });
  const base = Date.now() - scenario.priorMessages.length * 1_000 - 60_000;
  await prisma.message.createMany({
    data: scenario.priorMessages.map((message, index) => ({
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
  | { kind: 'escalated' }
  | { kind: 'replied'; text: string }
  | { kind: 'failure_notice' }
  | { kind: 'timeout' };

async function waitForTurn(seeded: SeededAgent, since: Date, startedAt: number): Promise<Outcome> {
  const poll = async (): Promise<Outcome> => {
    const rows = await prisma.message.findMany({
      where: { agentId: seeded.agentId, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });
    if (rows.some((row) => row.role === 'ASSISTANT' && row.text === CHAT_HANDLER_FAILURE_NOTICE)) {
      return { kind: 'failure_notice' };
    }
    const toolName = (row: (typeof rows)[number]) =>
      (row.metadata as { toolName?: string } | null)?.toolName;
    const reply = rows.find(
      (row) => row.role === 'TOOL' && toolName(row) === 'send_message_to_user'
    );
    if (reply) return { kind: 'replied', text: reply.text };
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: seeded.agentId } });
    const chip = rows.find((row) => row.role === 'TOOL' && toolName(row) === CLOUD_AGENT_TOOL_NAME);
    if (agent.temporalWorkflowId !== null && agent.temporalFirstExecutionRunId && chip) {
      return { kind: 'escalated' };
    }
    if (Date.now() - startedAt >= TURN_TIMEOUT_MS) return { kind: 'timeout' };
    await new Promise((resolve) => setTimeout(resolve, 50));
    return poll();
  };
  return poll();
}

interface Turn {
  outcome: Outcome;
  network: Network;
  seeded: SeededAgent;
  /** This turn's persisted web_search results, in order. */
  searchResults: string[];
  workflowGoal?: string;
}

async function runTurn(scenario: Scenario): Promise<Turn> {
  const seeded = await seedChatAgent(scenario);
  const since = new Date();
  const startedAt = Date.now();
  const network = installNetwork(scenario, startedAt);
  try {
    const posted = await postMessage(
      seeded.agentId,
      { message: scenario.userMessage },
      false,
      seeded.userId
    );
    assert.ok(!('error' in posted), `postMessage failed: ${JSON.stringify(posted)}`);
    const outcome = await waitForTurn(seeded, since, startedAt);
    // Let a discarded speculative Generator observe its abort before restoring fetch.
    await new Promise((resolve) => setTimeout(resolve, RECORD ? 3_000 : 200));
    const rows = await prisma.message.findMany({
      where: { agentId: seeded.agentId, role: 'TOOL', timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });
    const searchResults = rows
      .filter((row) => row.text.startsWith('Web search:'))
      .map((row) => row.text);
    const workflowGoal =
      outcome.kind === 'escalated' ? await startedWorkflowGoal(seeded.agentId) : undefined;
    return { outcome, network, seeded, searchResults, workflowGoal };
  } finally {
    network.restore();
  }
}

function describe(outcome: Outcome): string {
  return outcome.kind === 'replied' ? `replied: ${outcome.text}` : outcome.kind;
}

function routes(network: Network): ProviderRequest[] {
  return network.requests.filter(
    (request) => request.kind === 'router' && request.provider === 'cerebras'
  );
}

function assertCleanNetwork(network: Network): void {
  assert.deepEqual(network.unexpected, [], 'chat turn reached an unexpected outbound host');
  assert.deepEqual(
    network.unrecorded,
    [],
    'a request no longer matches its recording; re-record with CHAT_SEARCH_ESCALATION_RECORD=1'
  );
}

/** After every round of searches the Router routes again with all of them in context. */
function assertRoutesAfterEverySearchRound(turn: Turn): void {
  const routed = routes(turn.network);
  assert.ok(routed.length >= 2, 'after the web search the Router must route the turn again');
  for (const route of routed.slice(1)) {
    const contents = route.messages.map((message) => message.content);
    const seen = turn.searchResults.filter((text) => contents.includes(`[Tool Result]\n${text}`));
    assert.ok(seen.length > 0, 'each later route sees the search results before it');
  }
  const last = routed.at(-1);
  assert.ok(last);
  const lastSaw = turn.searchResults.every((text) =>
    last.messages.some((message) => message.content === `[Tool Result]\n${text}`)
  );
  assert.ok(lastSaw, 'the final route sees every search result of the turn');
}

// ── cases ────────────────────────────────────────────────────────────────────

async function testFirstTurnFindsOrEscalates(): Promise<void> {
  const turn = await runTurn(fixture.scenarios.firstTurn);
  try {
    assertCleanNetwork(turn.network);
    const answeredTitle = turn.outcome.kind === 'replied' && /Midori/i.test(turn.outcome.text);
    assert.ok(
      turn.outcome.kind === 'escalated' || answeredTitle,
      `a search that missed the manga must search on and name it (Uwasa no Midori-kun, ` +
        `which the Cloud Agent verified) or start the Cloud Agent, got ${describe(turn.outcome)}`
    );
    assertRoutesAfterEverySearchRound(turn);
  } finally {
    await cleanup(turn.seeded);
  }
}

async function testFollowUpMissEscalatesAfterSearchingAgain(): Promise<void> {
  const scenario = fixture.scenarios.followUpTurn;
  assert.equal(
    scenario.searchPolicy.mode,
    'pinned_snapshot',
    'this case owns failed-lookup escalation'
  );
  assert.ok(
    scenario.prodSearch,
    'failed-lookup evidence comes from the production search snapshot'
  );
  const snapshot = scenario.prodSearch;
  const turn = await runTurn(scenario);
  try {
    assertCleanNetwork(turn.network);
    assert.ok(turn.network.searched.length >= 2, 'the failed lookup must search again');
    assert.deepEqual(
      turn.network.servedSnapshots,
      turn.network.searched.map((query) => ({ query, results: snapshot.results })),
      'every follow-up query receives the same original unrelated production results'
    );
    const snapshotBody = snapshot.toolText.slice(`Web search: "${snapshot.query}"`.length);
    assert.deepEqual(
      [...turn.searchResults].sort(),
      turn.network.searched.map((query) => `Web search: "${query}"${snapshotBody}`).sort(),
      'persisted tool results contain the production snapshot under each actual Router query'
    );
    assert.equal(
      turn.outcome.kind,
      'escalated',
      `a search that did not find the manga must start the Cloud Agent, got ${describe(turn.outcome)}`
    );
    assertRoutesAfterEverySearchRound(turn);
    const routed = routes(turn.network);
    assert.ok(routed.length >= 3, 'the Router must be able to search again after a search');
    const lastRoute = routed.at(-1);
    assert.ok(lastRoute);
    const decision = JSON.parse(fixture.calls[lastRoute.fingerprint].content ?? '{}') as {
      action?: string;
      goal?: string;
    };
    assert.equal(decision.action, 'start_superintelligence', 'the last route escalated');
    assert.equal(turn.workflowGoal, decision.goal, 'the Cloud Agent starts on the Router goal');
  } finally {
    await cleanup(turn.seeded);
  }
}

async function testMultiPartQuestionSearchesInParallel(): Promise<void> {
  const turn = await runTurn(fixture.scenarios.multiPartQuestion);
  try {
    assertCleanNetwork(turn.network);
    assert.equal(turn.outcome.kind, 'replied', `got ${describe(turn.outcome)}`);
    const [first] = routes(turn.network);
    assert.ok(first, 'the turn starts with the Router');
    assert.ok(
      turn.searchResults.length >= 2,
      `a two-part question must run several queries, ran ${JSON.stringify(turn.network.searched)}`
    );
    assertRoutesAfterEverySearchRound(turn);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: turn.seeded.agentId } });
    assert.equal(agent.temporalWorkflowId, null, 'an answered search does not escalate');

    // The route that answered started one Generator alongside it; that one
    // wrote the reply and no Generator started after the route finished.
    const lastRoute = routes(turn.network).at(-1);
    assert.ok(lastRoute?.finishedAtMs !== undefined, 'the answering route finished');
    const generators = turn.network.requests.filter(
      (request) => request.kind === 'generator' && request.provider === 'cerebras'
    );
    const routeTail = lastContent(lastRoute);
    const overlapped = generators.filter(
      (request) =>
        lastContent(request) === routeTail && request.startedAtMs < lastRoute.finishedAtMs
    );
    assert.equal(overlapped.length, 1, 'one Generator overlaps the answering route');
    assert.ok(
      generators.every((request) => request.startedAtMs < lastRoute.finishedAtMs),
      'the answer is not generated again after the route'
    );
    const written = JSON.parse(fixture.calls[overlapped[0].fingerprint].content ?? '{}') as {
      response?: string;
    };
    assert.deepEqual(
      turn.outcome,
      { kind: 'replied', text: written.response },
      'the reply is the overlapped Generator'
    );
  } finally {
    await cleanup(turn.seeded);
  }
}

// ── runner ───────────────────────────────────────────────────────────────────

const CASES: Array<[ScenarioName, string, () => Promise<void>]> = [
  [
    'firstTurn',
    'exact prod first-turn search miss searches on and names the title, or escalates',
    testFirstTurnFindsOrEscalates,
  ],
  [
    'followUpTurn',
    'exact prod follow-up search miss searches again, then escalates',
    testFollowUpMissEscalatesAfterSearchingAgain,
  ],
  [
    'multiPartQuestion',
    'a two-part question fans out into parallel searches and answers once',
    testMultiPartQuestionSearchesInParallel,
  ],
];

async function main(): Promise<number> {
  process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND = '1';
  process.env.BLACKBOX_TEST_FAKE_TEMPORAL = '1';
  const savedKeys = {
    cerebras: process.env.CEREBRAS_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    parallel: process.env.PARRALLEL_API_KEY,
  };
  if (!RECORD) {
    process.env.CEREBRAS_API_KEY = 'blackbox-cerebras-key';
    process.env.OPENROUTER_API_KEY = 'blackbox-openrouter-key';
    process.env.PARRALLEL_API_KEY = 'blackbox-parallel-key';
  }

  try {
    if (RECORD) {
      fixture.calls = {};
      for (const [name] of CASES) {
        const turn = await runTurn(fixture.scenarios[name]);
        await cleanup(turn.seeded);
        process.stdout.write(
          `record ${name}: ${describe(turn.outcome)} after ${routes(turn.network).length} routes, ` +
            `searches ${JSON.stringify(turn.network.searched)}\n`
        );
      }
      await settleRecordings();
      fixture.recordedAt = new Date().toISOString().slice(0, 10);
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
      process.stdout.write(`recorded ${FIXTURE_PATH}\n`);
      return 0;
    }

    let failed = 0;
    for (const [, name, run] of CASES) {
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
    if (failed > 0) {
      process.stdout.write(`\n${failed}/${CASES.length} chat-search-escalation cases failed\n`);
      return 1;
    }
    process.stdout.write(`\nPASS chat-search-escalation (${CASES.length} cases)\n`);
    return 0;
  } finally {
    for (const [key, value] of [
      ['CEREBRAS_API_KEY', savedKeys.cerebras],
      ['OPENROUTER_API_KEY', savedKeys.openrouter],
      ['PARRALLEL_API_KEY', savedKeys.parallel],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.$disconnect();
  }
}

void main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  }
);
