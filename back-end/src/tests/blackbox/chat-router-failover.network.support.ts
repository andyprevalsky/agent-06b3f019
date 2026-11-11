/**
 * Network boundary for chat-router-failover: replays the provider streams
 * recorded on the e8f2279b router request at their recorded offsets, stalls
 * what a scenario stalls, passes live requests through, answers the turn's
 * web searches with no results, and records every request the chat turn makes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS } from '../../providers/chat/routerCompletionDeadline';
import { prisma } from '../../providers/database';
import { OPENROUTER_FAST_CHAT_MODEL } from '../../providers/rose/openrouterFastRoute';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import {
  groupDecisionRounds,
  type LiveObservation,
  observedLiveFetch,
} from './chat-router-failover.live.support';

const here = dirname(fileURLToPath(import.meta.url));

export interface RecordedEvent {
  dt: number;
  line: string;
}

export const streams = JSON.parse(
  readFileSync(join(here, '../fixtures/chat-router-failover-prod-e8f2279b-streams.json'), 'utf8')
) as {
  cerebrasStall: RecordedEvent[];
  cerebrasHealthy: { events: RecordedEvent[] };
  openrouterGlm: { events: RecordedEvent[] };
};

export type Behavior =
  | 'stall'
  | 'healthy'
  | 'healthy-long-prefill'
  | 'glm-recorded'
  | 'glm-recorded-long-context'
  | 'glm-recorded-slowest'
  | 'live';

/**
 * Extra delay before a recorded stream starts, so its first content lands when
 * it did on the longest prod router context (agent 3b5c2813, 88k GLM / 96k
 * Cerebras tokens) replayed live on 2026-10-01: 2,935ms after the request on
 * direct Cerebras and 6,539ms on GLM.
 */
export const LONG_PREFILL_CEREBRAS_DELAY_MS = 2_935 - 784;
export const LONG_CONTEXT_GLM_DELAY_MS = 6_539 - 3_073;
/**
 * The slowest GLM first content in that replay: 8,583ms after the request
 * (agent 26576873's 1.7k-token context, Cerebras-wide outage).
 */
export const SLOWEST_GLM_DELAY_MS = 8_583 - 3_073;

/** Live requests also record the OpenRouter host that served, and when. */
export interface ProviderRequest extends LiveObservation {
  /** Fetch-order position among the turn's provider and search requests. */
  seq: number;
  provider: 'cerebras' | 'openrouter';
  model: string;
  schema: string;
  messageCount: number;
  transcriptChars: number;
  /** Fresh runtime metadata added after the recorded conversation. */
  runtimeClock: string;
  sessionId?: string;
  atMs: number;
  /** When, and why, the chat turn aborted this request. */
  abortedAtMs?: number;
  abortReason?: string;
}

export interface Scenario {
  cerebras: (routerAttempt: number) => Behavior;
  glm: (routerAttempt: number) => Behavior;
  openrouterOther: Behavior;
}

/** Replays recorded SSE lines at their recorded offsets (plus `delayMs`); optionally stays open. */
function replayResponse(
  events: RecordedEvent[],
  signal: AbortSignal | null | undefined,
  holdOpen: boolean,
  delayMs = 0
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
          }, event.dt + delayMs)
        );
      });
    },
    cancel() {
      timers.forEach(clearTimeout);
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function transcriptChars(messages: Array<{ role?: string; content?: unknown }>): number {
  return messages.reduce((total, message) => {
    if (message.role === 'system') return total;
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

/**
 * The chat turn's web-search dependency (chatTools.ts `fetchParallelSearch`).
 * The router may search and fan out queries before it decides again
 * (bcee7f02c), so each POST here is answered in-process with no results: this
 * probe tests routing failover, not search, and the live router then decides
 * on "No results found." Any other method or path at this host is still a
 * stray outbound call.
 */
export const PARALLEL_SEARCH_URL = 'https://api.parallel.ai/v1/search';

export interface SearchRequest {
  /** Fetch-order position among the turn's provider and search requests. */
  seq: number;
  atMs: number;
  objective: string;
  queries: string[];
  /** Same objective already sent in this batch: the product's 1.5s hedge duplicate (or a retry). */
  hedgeDuplicate: boolean;
}

function describeSearchRequests(searches: readonly SearchRequest[]): string {
  return searches
    .map((search) => {
      const hedge = search.hedgeDuplicate ? ' (hedge duplicate)' : '';
      return `  web search at ${search.atMs}ms${hedge}: ${search.objective}\n`;
    })
    .join('');
}

export function installNetwork(scenario: Scenario, startedAt: number) {
  const realFetch = globalThis.fetch;
  const requests: ProviderRequest[] = [];
  const searchRequests: SearchRequest[] = [];
  const unexpected: string[] = [];
  const alerts: string[] = [];
  let seq = 0;
  /** Index in `searchRequests` where the current batch of consecutive searches began. */
  let searchBatchStart: number | undefined;
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
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (url === PARALLEL_SEARCH_URL && method === 'POST') {
      const search = JSON.parse(String(init?.body)) as {
        objective?: string;
        search_queries?: string[];
      };
      const objective = String(search.objective ?? '');
      searchBatchStart ??= searchRequests.length;
      searchRequests.push({
        seq: seq++,
        atMs: Date.now() - startedAt,
        objective,
        queries: search.search_queries ?? [],
        hedgeDuplicate: searchRequests
          .slice(searchBatchStart)
          .some((earlier) => earlier.objective === objective),
      });
      return new Response('{"results":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url !== CEREBRAS_API_URL && url !== OPENROUTER_API_URL) {
      unexpected.push(url);
      throw new Error(`chat-router-failover: unexpected outbound ${url}`);
    }
    searchBatchStart = undefined;
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ role?: string; content?: unknown }>;
      response_format?: { json_schema?: { name?: string } };
      session_id?: string;
    };
    const schema = body.response_format?.json_schema?.name ?? '';
    const runtimeClock = body.messages.at(-1);
    assert.equal(runtimeClock?.role, 'user', 'runtime metadata must follow the full transcript');
    assert.equal(typeof runtimeClock?.content, 'string');
    assert.match(String(runtimeClock?.content), /^<system-reminder>\nCurrent UTC time:/);
    const provider = url === CEREBRAS_API_URL ? 'cerebras' : 'openrouter';
    const request: ProviderRequest = {
      seq: seq++,
      provider,
      model: body.model,
      schema,
      messageCount: body.messages.length,
      transcriptChars: transcriptChars(body.messages),
      runtimeClock: String(runtimeClock?.content),
      sessionId: body.session_id,
      atMs: Date.now() - startedAt,
    };
    requests.push(request);
    init?.signal?.addEventListener(
      'abort',
      () => {
        const reason: unknown = init.signal?.reason;
        request.abortedAtMs = Date.now() - startedAt;
        request.abortReason = reason instanceof Error ? reason.message : String(reason);
      },
      { once: true }
    );
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
      case 'healthy-long-prefill':
        return replayResponse(
          streams.cerebrasHealthy.events,
          signal,
          false,
          LONG_PREFILL_CEREBRAS_DELAY_MS
        );
      case 'glm-recorded':
        return replayResponse(streams.openrouterGlm.events, signal, false);
      case 'glm-recorded-long-context':
        return replayResponse(
          streams.openrouterGlm.events,
          signal,
          false,
          LONG_CONTEXT_GLM_DELAY_MS
        );
      case 'glm-recorded-slowest':
        return replayResponse(streams.openrouterGlm.events, signal, false, SLOWEST_GLM_DELAY_MS);
      case 'stall':
        return replayResponse(provider === 'cerebras' ? streams.cerebrasStall : [], signal, true);
    }
  }) as typeof fetch;

  return {
    requests,
    searchRequests,
    unexpected,
    alerts,
    /** The turn's router decisions in order, each with its attempts and the search batch that closed it. */
    decisionRounds: () => groupDecisionRounds(requests, searchRequests, OPENROUTER_FAST_CHAT_MODEL),
    describeSearches: () => describeSearchRequests(searchRequests),
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

export type FailoverNetwork = ReturnType<typeof installNetwork>;

/** Observe the real router clock; optionally hold only this fixture's later persistence. */
export function observeRouterCompletion(
  agentId: string,
  routerBoundMs: number,
  holdPostDecisionPersistence: boolean
) {
  const originalWrite = process.stdout.write;
  const originalCreate = prisma.message.create;
  const starts: string[] = [];
  const completions: Array<{ streamId: string; durationMs: number; observedAt: number }> = [];
  const pendingCreates: Promise<unknown>[] = [];
  let heldWrites = 0;
  process.stdout.write = function (
    this: typeof process.stdout,
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ) {
    const text = (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
      .trim();
    let record: Record<string, unknown> | undefined;
    try {
      if (text.startsWith('{')) record = JSON.parse(text) as Record<string, unknown>;
      else if (text.includes('[RouterLLM]')) {
        const event =
          /\[RouterLLM\] (Starting streaming for routing decision|Streaming complete)/.exec(text);
        if (event) {
          record = { component: 'RouterLLM', message: `[RouterLLM] ${event[1]}` };
          for (const key of ['agentId', 'streamId', 'durationMs']) {
            const value = new RegExp(`\\b${key}=([^ ]+)`).exec(text)?.[1];
            record[key] = key === 'durationMs' ? Number(value) : value;
          }
        }
      }
    } catch {
      // Other stdout is forwarded unchanged and cannot supply a measurement.
    }
    if (
      record?.component === 'RouterLLM' &&
      record.agentId === agentId &&
      typeof record.streamId === 'string' &&
      record.streamId.length > 0
    ) {
      if (record.message === '[RouterLLM] Starting streaming for routing decision') {
        starts.push(String(record.streamId));
      } else if (record.message === '[RouterLLM] Streaming complete') {
        completions.push({
          streamId: String(record.streamId),
          durationMs: Number(record.durationMs),
          observedAt: Date.now(),
        });
      }
    }
    return Reflect.apply(originalWrite, this, [chunk, ...rest]);
  } as typeof process.stdout.write;
  prisma.message.create = ((...args: Parameters<typeof originalCreate>) => {
    const completion = completions[0];
    if (
      holdPostDecisionPersistence &&
      heldWrites === 0 &&
      completion &&
      starts.length === 1 &&
      completion.streamId === starts[0] &&
      args[0].data.agentId === agentId &&
      args[0].data.role === 'ASSISTANT'
    ) {
      heldWrites += 1;
      // The router has already finished. Make the independent persistence boundary
      // cross its 15s clock without changing any router/provider timer or stream.
      const remaining = Math.max(
        0,
        completion.observedAt - completion.durationMs + routerBoundMs + 100 - Date.now()
      );
      const pending = new Promise<void>((resolve) => setTimeout(resolve, remaining)).then(() =>
        Reflect.apply(originalCreate, prisma.message, args)
      );
      pendingCreates.push(pending);
      return pending;
    }
    return Reflect.apply(originalCreate, prisma.message, args);
  }) as typeof originalCreate;
  return {
    durationMs() {
      assert.equal(starts.length, 1, 'one correlated router start is required');
      assert.equal(completions.length, 1, 'one measured router completion is required');
      assert.equal(completions[0].streamId, starts[0], 'completion must own the started stream');
      assert.ok(Number.isFinite(completions[0].durationMs) && completions[0].durationMs > 0);
      assert.equal(
        heldWrites,
        holdPostDecisionPersistence ? 1 : 0,
        'only the selected postdecision persistence must exercise the hold'
      );
      return completions[0].durationMs;
    },
    async restore() {
      try {
        await Promise.allSettled(pendingCreates);
      } finally {
        process.stdout.write = originalWrite;
        prisma.message.create = originalCreate;
      }
    },
  };
}

export function firstContentDt(events: RecordedEvent[]): number {
  const event = events.find((candidate) => /"content":"[^"]/.test(candidate.line));
  assert.ok(event, 'recorded stream must carry content');
  return event.dt;
}

export function warnTiming(condition: boolean, message: string): void {
  if (!condition) process.stderr.write(`timing warning: ${message}\n`);
}

/** Wall-clock warnings for a measured turn; the router stream duration itself is required. */
export function warnRouterTiming(
  turnElapsedMs: number,
  routerDurationMs: number | undefined
): void {
  warnTiming(turnElapsedMs < 40_000, `persisted turn took ${turnElapsedMs}ms`);
  assert.ok(routerDurationMs !== undefined, 'actual router stream duration is required');
  warnTiming(
    routerDurationMs < DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS,
    `measured router stream took ${routerDurationMs}ms; persisted turn took ${turnElapsedMs}ms`
  );
}
