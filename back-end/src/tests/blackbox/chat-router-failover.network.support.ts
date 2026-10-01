/**
 * Network boundary for chat-router-failover: replays the provider streams
 * recorded on the e8f2279b router request at their recorded offsets, stalls
 * what a scenario stalls, passes live requests through, and records every
 * request the chat turn makes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OPENROUTER_FAST_CHAT_MODEL } from '../../providers/rose/openrouterFastRoute';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import { type LiveObservation, observedLiveFetch } from './chat-router-failover.live.support';

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
  | 'live';

/**
 * Extra delay before a recorded stream starts, so its first content lands when
 * it did on the longest prod router context (agent 3b5c2813, 88k GLM / 96k
 * Cerebras tokens) replayed live on 2026-10-01: 2,935ms after the request on
 * direct Cerebras and 6,539ms on GLM.
 */
export const LONG_PREFILL_CEREBRAS_DELAY_MS = 2_935 - 784;
export const LONG_CONTEXT_GLM_DELAY_MS = 6_539 - 3_073;

/** Live requests also record the OpenRouter host that served, and when. */
export interface ProviderRequest extends LiveObservation {
  provider: 'cerebras' | 'openrouter';
  model: string;
  schema: string;
  messageCount: number;
  transcriptChars: number;
  sessionId?: string;
  atMs: number;
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

export function installNetwork(scenario: Scenario, startedAt: number) {
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
      messages: Array<{ role?: string; content?: unknown }>;
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
      transcriptChars: transcriptChars(body.messages),
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

export type FailoverNetwork = ReturnType<typeof installNetwork>;

export function firstContentDt(events: RecordedEvent[]): number {
  const event = events.find((candidate) => /"content":"[^"]/.test(candidate.line));
  assert.ok(event, 'recorded stream must carry content');
  return event.dt;
}
