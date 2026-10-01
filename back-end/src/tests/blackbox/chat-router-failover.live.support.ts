/**
 * Live-probe support for chat-router-failover: tees a real OpenRouter stream so
 * the probe can report which host served and how fast without changing what
 * the Rose client reads, pins which OpenRouter account it probes, and decides
 * whether a miss was OpenRouter's (re-probe once) or ours (fail now).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { defaultPayloadConverter } from '@temporalio/client';
import { parse as parseDotenv } from 'dotenv';

import { buildAgentWorkflowStartHistoryRequest, getTemporalClient } from '../../providers/temporal';

export interface LiveObservation {
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

/** Real fetch whose stream is also read into `observation` (times from the request). */
export async function observedLiveFetch(
  realFetch: typeof fetch,
  input: string | URL | Request,
  init: RequestInit | undefined,
  observation: LiveObservation
): Promise<Response> {
  const sentAt = Date.now();
  const response = await realFetch(input, init);
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
 * OpenRouter did not deliver this request's first content inside the budget:
 * no response headers at all, or a 200 whose first content came late or never.
 * Any other status, or events without the host field, is ours to fix.
 */
function isOpenRouterSideMiss(request: LiveObservation, budgetMs: number): boolean {
  if (request.status === undefined) return true;
  if (request.status !== 200) return false;
  if (request.firstEventMs !== undefined && request.upstreamProvider === undefined) return false;
  return request.firstContentMs === undefined || request.firstContentMs > budgetMs;
}

export function describeLiveRequests(requests: LiveObservation[]): string {
  return requests
    .map(
      (request, index) =>
        `attempt ${index + 1}: ${request.upstreamProvider ?? 'no host'}, HTTP ` +
        `${request.status ?? '-'} at ${request.headersMs ?? '-'}ms, first event ` +
        `${request.firstEventMs ?? '-'}ms, first content ${request.firstContentMs ?? '-'}ms`
    )
    .join('; ');
}

export interface LiveSample {
  outcome: { kind: 'escalated' | 'apology' | 'timeout'; atMs: number };
  /** Router attempts (one Cerebras router request each). */
  attempts: number;
  /** The GLM failover request of each router attempt, in order. */
  glm: LiveObservation[];
  alerts: string[];
  goal?: string;
}

function assertServedOnFirstAttempt(sample: LiveSample, correctedAddress: RegExp): void {
  assert.equal(
    sample.outcome.kind,
    'escalated',
    `live GLM failover must escalate the exact prod follow-up, got ${sample.outcome.kind} after ` +
      `${sample.outcome.atMs}ms over ${sample.attempts} router attempt(s)`
  );
  assert.equal(
    sample.attempts,
    1,
    `the live GLM failover must serve inside the first router attempt's bounds ` +
      `(${describeLiveRequests(sample.glm)})`
  );
  assert.deepEqual(sample.alerts, [], 'a served turn must not raise an error alert');
  assert.match(
    sample.goal ?? '',
    correctedAddress,
    'the re-plan goal must carry the corrected address'
  );
}

/** Every GLM request that did not serve the turn missed on OpenRouter's side. */
function missedOnOpenRouterSide(sample: LiveSample, budgetMs: number): boolean {
  if (sample.outcome.kind === 'timeout') return false;
  const unserved = sample.outcome.kind === 'escalated' ? sample.glm.slice(0, -1) : sample.glm;
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
  correctedAddress: RegExp;
}): Promise<void> {
  const first = await params.runSample('sample 1');
  let firstMiss: unknown;
  try {
    assertServedOnFirstAttempt(first, params.correctedAddress);
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
    assertServedOnFirstAttempt(second, params.correctedAddress);
  } catch (error) {
    throw new Error(
      `live GLM failover missed in two samples ${delayS}s apart. ` +
        `First: ${String(firstMiss)}. Second: ${String(error)}`
    );
  }
}
