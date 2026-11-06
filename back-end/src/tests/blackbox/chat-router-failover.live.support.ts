/**
 * Live-probe support for chat-router-failover: tees a real OpenRouter stream so
 * the probe can report which host served and how fast without changing what
 * the Rose client reads, pins which OpenRouter account it probes, and decides
 * whether a miss was OpenRouter's (re-probe once) or ours (fail now).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import diagnostics from 'node:diagnostics_channel';
import { existsSync, readFileSync } from 'node:fs';

import { defaultPayloadConverter } from '@temporalio/client';
import { parse as parseDotenv } from 'dotenv';

import { buildAgentWorkflowStartHistoryRequest, getTemporalClient } from '../../providers/temporal';

export interface LiveObservation {
  /** Set when this request opened a new connection; times are from the request. */
  connectStartMs?: number;
  connectedMs?: number;
  status?: number;
  headersMs?: number;
  upstreamProvider?: string;
  firstEventMs?: number;
  firstContentMs?: number;
}

async function observeLiveStream(
  stream: ReadableStream<Uint8Array>,
  observation: LiveObservation,
  sentAt: number
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (observation.firstContentMs === undefined) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        const event = JSON.parse(line.slice('data: '.length)) as {
          provider?: string;
          choices?: Array<{ delta?: { content?: string } }>;
        };
        observation.firstEventMs ??= Date.now() - sentAt;
        observation.upstreamProvider ??= event.provider;
        if (event.choices?.[0]?.delta?.content) {
          observation.firstContentMs = Date.now() - sentAt;
          break;
        }
      }
    }
  } catch {
    // The router or the race aborted this request; whatever was observed stands.
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * Times the TCP/TLS connect a request opens. The probe sends one real request
 * at a time (every other route is stalled in-process), so any connect to the
 * request's host while it waits for headers is that request's.
 */
function observeConnect(host: string, observation: LiveObservation, sentAt: number): () => void {
  const isHost = (message: unknown) =>
    (message as { connectParams?: { hostname?: string } }).connectParams?.hostname === host;
  const onConnectStart = (message: unknown) => {
    if (isHost(message)) observation.connectStartMs ??= Date.now() - sentAt;
  };
  const onConnected = (message: unknown) => {
    if (isHost(message)) observation.connectedMs ??= Date.now() - sentAt;
  };
  diagnostics.subscribe('undici:client:beforeConnect', onConnectStart);
  diagnostics.subscribe('undici:client:connected', onConnected);
  return () => {
    diagnostics.unsubscribe('undici:client:beforeConnect', onConnectStart);
    diagnostics.unsubscribe('undici:client:connected', onConnected);
  };
}

/** Real fetch whose stream is also read into `observation` (times from the request). */
export async function observedLiveFetch(
  realFetch: typeof fetch,
  input: string | URL | Request,
  init: RequestInit | undefined,
  observation: LiveObservation
): Promise<Response> {
  const sentAt = Date.now();
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const stopObservingConnect = observeConnect(new URL(url).hostname, observation, sentAt);
  let response: Response;
  try {
    response = await realFetch(input, init);
  } finally {
    stopObservingConnect();
  }
  observation.status = response.status;
  observation.headersMs = Date.now() - sentAt;
  if (!response.body) return response;
  const [forCaller, forProbe] = response.body.tee();
  void observeLiveStream(forProbe, observation, sentAt);
  return new Response(forCaller, { status: response.status, headers: response.headers });
}

function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * OpenRouter account settings (ignored providers, data policy) decide which
 * GLM hosts a request may reach, so the probe must run on the account the
 * backend is configured with, not on a key an outer shell injected.
 */
export function assertProbesConfiguredOpenRouterAccount(envFile: string): string {
  const used = process.env.OPENROUTER_API_KEY;
  if (!used) throw new Error('live probe requires OPENROUTER_API_KEY');
  if (!existsSync(envFile)) {
    throw new Error(
      `live probe needs ${envFile} to know which OpenRouter account the backend uses`
    );
  }
  const configured = parseDotenv(readFileSync(envFile)).OPENROUTER_API_KEY;
  if (!configured) throw new Error(`${envFile} sets no OPENROUTER_API_KEY`);
  const usedFingerprint = keyFingerprint(used);
  if (usedFingerprint !== keyFingerprint(configured)) {
    throw new Error(
      `live probe would use OpenRouter key ${usedFingerprint}, but ${envFile} configures ` +
        `${keyFingerprint(configured)}; an injected OPENROUTER_API_KEY probes another account`
    );
  }
  return usedFingerprint;
}

/** `buildAgentWorkflowArgs` position of the goal the workflow starts with. */
const WORKFLOW_GOAL_ARG = 2;

/** Goal the (in-memory) Temporal workflow was started with on escalation. */
export async function startedWorkflowGoal(workflowId: string): Promise<string | undefined> {
  const client = await getTemporalClient();
  const response = await client.workflowService.getWorkflowExecutionHistory(
    buildAgentWorkflowStartHistoryRequest(client.options.namespace, workflowId)
  );
  const payloads =
    response.history?.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads ?? [];
  const payload = payloads[WORKFLOW_GOAL_ARG];
  const goal: unknown = payload ? defaultPayloadConverter.fromPayload(payload) : undefined;
  return typeof goal === 'string' ? goal : undefined;
}

/**
 * OpenRouter did not deliver this request's first content inside the budget
 * after the request reached it: no response headers at all, or a 200 whose
 * first content came late or never. A connect that never completed, any other
 * status, or events without the host field is ours to fix.
 */
function isOpenRouterSideMiss(request: LiveObservation, budgetMs: number): boolean {
  if (request.connectStartMs !== undefined && request.connectedMs === undefined) return false;
  if (request.status === undefined) return true;
  if (request.status !== 200) return false;
  if (request.firstEventMs !== undefined && request.upstreamProvider === undefined) return false;
  return request.firstContentMs === undefined || request.firstContentMs > budgetMs;
}

function describeConnect(request: LiveObservation): string {
  if (request.connectStartMs === undefined) return 'reused connection';
  if (request.connectedMs === undefined)
    return `connect started ${request.connectStartMs}ms, never completed`;
  return `connected ${request.connectedMs}ms`;
}

export function describeLiveRequests(requests: LiveObservation[]): string {
  return requests
    .map(
      (request, index) =>
        `attempt ${index + 1}: ${request.upstreamProvider ?? 'no host'}, ` +
        `${describeConnect(request)}, HTTP ${request.status ?? '-'} at ` +
        `${request.headersMs ?? '-'}ms, first event ${request.firstEventMs ?? '-'}ms, ` +
        `first content ${request.firstContentMs ?? '-'}ms`
    )
    .join('; ');
}

/** What round grouping reads from a recorded request: its fetch-order position, never its clock. */
export interface RoundRequest extends LiveObservation {
  seq: number;
  schema: string;
  provider: 'cerebras' | 'openrouter';
  model: string;
}

/** One router decision of a chat turn: its attempts and the search batch, if any, that closed it. */
export interface DecisionRound<R extends LiveObservation = LiveObservation> {
  /** Router attempts (one direct Cerebras router request each; a regenerate is another). */
  attempts: number;
  /** The GLM failover request of each attempt that reached the hedge, in order. */
  glm: R[];
  /** Router requests on the other OpenRouter route (the Qwen race branch). */
  otherRoutes: number;
  /** Parallel search POSTs that followed this round's decision and closed it. */
  searchRequests: number;
}

/**
 * Groups a turn's requests into decision rounds structurally: only
 * router_decision requests open attempts, a round closes at the first search
 * request after its decision, and the next router_decision request opens the
 * next round. Order is the fetch-order `seq`, so a stalled Cerebras or Qwen
 * request that is aborted late, or whose clock reads late, stays in the round
 * that issued it. A search before any decision opens an attempt-less round.
 */
export function groupDecisionRounds<R extends RoundRequest>(
  requests: readonly R[],
  searches: ReadonlyArray<{ seq: number }>,
  glmModel: string
): DecisionRound<R>[] {
  const events = [
    ...requests
      .filter((request) => request.schema === 'router_decision')
      .map((request) => ({ seq: request.seq, request })),
    ...searches.map((search) => ({ seq: search.seq, request: undefined })),
  ].sort((a, b) => a.seq - b.seq);
  const rounds: DecisionRound<R>[] = [];
  const open = (): DecisionRound<R> => {
    const round: DecisionRound<R> = { attempts: 0, glm: [], otherRoutes: 0, searchRequests: 0 };
    rounds.push(round);
    return round;
  };
  let round: DecisionRound<R> | undefined;
  for (const event of events) {
    if (event.request === undefined) {
      round ??= open();
      round.searchRequests += 1;
      continue;
    }
    if (round === undefined || round.searchRequests > 0) round = open();
    if (event.request.provider === 'cerebras') round.attempts += 1;
    else if (event.request.model === glmModel) round.glm.push(event.request);
    else round.otherRoutes += 1;
  }
  return rounds;
}

export function describeDecisionRounds(rounds: DecisionRound[]): string {
  return rounds
    .map((round, index) => {
      const closed =
        round.searchRequests > 0 ? `, then ${round.searchRequests} search POST(s)` : '';
      const glm = describeLiveRequests(round.glm) || 'no GLM request';
      return `round ${index + 1} (${round.attempts} attempt(s)${closed}): ${glm}`;
    })
    .join(' | ');
}

export interface LiveSample {
  outcome: { kind: 'escalated' | 'apology' | 'timeout'; atMs: number };
  /** Router attempts of the decision round that produced the outcome (one Cerebras router request each). */
  attempts: number;
  /** The GLM failover request of each of that round's attempts, in order. */
  glm: LiveObservation[];
  /** Every decision round of the turn, in order; a round before the last was closed by a web-search batch. */
  rounds: DecisionRound[];
  alerts: string[];
  goal?: string;
}

/** The turn's network observations as a sample; every attempt of every round must have reached GLM. */
export function liveSampleOf(
  network: { decisionRounds(): DecisionRound[]; alerts: string[] },
  turn: Pick<LiveSample, 'outcome' | 'goal'>
): LiveSample {
  const rounds = network.decisionRounds();
  rounds.forEach((round, index) => {
    assert.equal(
      round.glm.length,
      round.attempts,
      `decision round ${index + 1}: every router attempt must reach the real GLM failover`
    );
  });
  const outcomeRound = rounds.at(-1);
  assert.ok(outcomeRound, 'the turn must make a router decision');
  const { attempts, glm } = outcomeRound;
  return { ...turn, attempts, glm, rounds, alerts: network.alerts };
}

export function describeLiveSample(label: string, sample: LiveSample): string {
  return (
    `  live GLM failover (${label}): ${sample.outcome.kind} at ${sample.outcome.atMs}ms over ` +
    `${sample.rounds.length} decision round(s); ${describeDecisionRounds(sample.rounds)}\n`
  );
}

/** The address the user corrected the run to, and the one they rejected. */
export interface GoalAnchor {
  corrected: RegExp;
  rejected: RegExp;
}

const NEGATION =
  /\b(?:not|never|no longer|avoid|ignore|skip|instead|rather|except|excluding)\b(?!\s+(?:too\s+)?far\b)|n't\b/i;
/** `.`, `!`, or `?` before a capitalized word or the end, unless it closes `Sat.`, `St.`, or `e.g.`. */
const SENTENCE_END = /(?<!\b[A-Z][A-Za-z]{0,3}|\b[a-z]\.[a-z])[.!?](?=\s+[A-Z]|\s*$)|\n/;

/** Whether a negation leads the clause up to `at` (its last six words). */
function negatedAt(text: string, at: number): boolean {
  const clause =
    text
      .slice(0, at)
      .split(/[,;:()[\]—]/)
      .pop() ?? '';
  return NEGATION.test(clause.trim().split(/\s+/).slice(-6).join(' '));
}

/**
 * Why `goal` does not send the re-planned run to the corrected address, or
 * undefined. The replayed context says not to anchor on that address and names
 * the rejected one, so a goal that only mentions it proves nothing: the first
 * non-negated mention of either place in the goal's first sentence, which
 * states what the run does, must be the corrected one. Later recaps of the
 * earlier search do not count.
 */
export function goalAnchorFailure(
  goal: string | undefined,
  anchor: GoalAnchor
): string | undefined {
  if (!goal) return 'no re-plan goal was started';
  const end = SENTENCE_END.exec(goal);
  const sentence = end ? goal.slice(0, end.index) : goal;
  const mentionsOf = (place: RegExp, corrected: boolean) =>
    [...sentence.matchAll(new RegExp(place.source, 'gi'))].map((match) => ({
      at: match.index,
      corrected,
    }));
  const first = [...mentionsOf(anchor.corrected, true), ...mentionsOf(anchor.rejected, false)]
    .sort((a, b) => a.at - b.at)
    .find((mention) => !negatedAt(sentence, mention.at));
  if (!first) {
    return `the re-plan goal's first sentence does not name ${anchor.corrected.source}: ${goal}`;
  }
  if (!first.corrected) return `the re-plan goal anchors on the rejected address first: ${goal}`;
  return undefined;
}

export function assertServedOnFirstAttempt(sample: LiveSample, goalAnchor: GoalAnchor): void {
  assert.equal(
    sample.outcome.kind,
    'escalated',
    `live GLM failover must escalate the exact prod follow-up, got ${sample.outcome.kind} after ` +
      `${sample.outcome.atMs}ms over ${sample.rounds.length} decision round(s) ` +
      `(${describeDecisionRounds(sample.rounds)})`
  );
  // Each decision the turn made, searching or escalating, must come from its first attempt.
  sample.rounds.forEach((round, index) => {
    assert.equal(
      round.attempts,
      1,
      `decision round ${index + 1} of ${sample.rounds.length} must be served inside its first ` +
        `router attempt's bounds (${describeLiveRequests(round.glm)})`
    );
  });
  assert.equal(
    sample.attempts,
    1,
    `the live GLM failover must serve inside the first router attempt's bounds ` +
      `(${describeLiveRequests(sample.glm)})`
  );
  assert.deepEqual(sample.alerts, [], 'a served turn must not raise an error alert');
  assert.equal(goalAnchorFailure(sample.goal, goalAnchor), undefined);
}

/**
 * Every GLM request that did not serve a decision missed on OpenRouter's side.
 * A round closed by a search was served by its last attempt, as was the
 * escalating round; an apology leaves its round unserved.
 */
function missedOnOpenRouterSide(sample: LiveSample, budgetMs: number): boolean {
  if (sample.outcome.kind === 'timeout') return false;
  const unserved = sample.rounds.flatMap((round, index) => {
    const served = index < sample.rounds.length - 1 || sample.outcome.kind === 'escalated';
    return served ? round.glm.slice(0, -1) : round.glm;
  });
  return (
    unserved.length > 0 && unserved.every((request) => isOpenRouterSideMiss(request, budgetMs))
  );
}

/**
 * One sample decides, except a miss OpenRouter caused (no headers, or no first
 * content inside the budget): that is re-probed once after `reprobeDelayMs`,
 * and a second miss fails. Every other failure fails at once.
 */
export async function probeLiveFailover(params: {
  runSample: (label: string) => Promise<LiveSample>;
  budgetMs: number;
  reprobeDelayMs: number;
  goalAnchor: GoalAnchor;
}): Promise<void> {
  const first = await params.runSample('sample 1');
  let firstMiss: unknown;
  try {
    assertServedOnFirstAttempt(first, params.goalAnchor);
    return;
  } catch (error) {
    if (!missedOnOpenRouterSide(first, params.budgetMs)) throw error;
    firstMiss = error;
  }
  const delayS = params.reprobeDelayMs / 1000;
  process.stdout.write(`  OpenRouter-side miss; re-probing once in ${delayS}s\n`);
  await new Promise((resolve) => setTimeout(resolve, params.reprobeDelayMs));
  const second = await params.runSample('sample 2');
  try {
    assertServedOnFirstAttempt(second, params.goalAnchor);
  } catch (error) {
    throw new Error(
      `live GLM failover missed in two samples ${delayS}s apart. ` +
        `First: ${String(firstMiss)}. Second: ${String(error)}`
    );
  }
}
