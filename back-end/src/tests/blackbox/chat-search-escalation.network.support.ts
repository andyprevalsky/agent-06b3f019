/**
 * Provider stream helpers for chat-search-escalation: replay a recorded
 * completion as OpenAI-compatible SSE, hold a hedge loser open until abort,
 * and record a live stream's content while passing it through.
 */

import { randomUUID } from 'node:crypto';

import { retryWithBackoff } from '../../providers/retry';

/** A provider completion recorded for one exact request (keyed by its fingerprint). */
export interface RecordedCall {
  kind: string;
  model: string;
  /** null when the handler discarded this speculative request before it finished. */
  content: string | null;
}

/** Replayed content arrives in four deltas this far apart. */
const STREAM_STEP_MS = 100;

function chunkLine(id: string, model: string, choice: Record<string, unknown>, extra = {}): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, ...choice }],
    ...extra,
  })}`;
}

/** Serves recorded content as an OpenAI-compatible SSE stream, honoring abort. */
export function replayCall(
  recorded: { model: string; content: string },
  signal: AbortSignal | null | undefined,
  onFinished: () => void
): Response {
  const id = `chatcmpl-${randomUUID()}`;
  const quarter = Math.ceil(recorded.content.length / 4);
  const deltas = [0, 1, 2, 3].map((index) =>
    recorded.content.slice(index * quarter, (index + 1) * quarter)
  );
  const lines = [
    chunkLine(id, recorded.model, { delta: { role: 'assistant' } }),
    ...deltas.map((content) => chunkLine(id, recorded.model, { delta: { content } })),
    chunkLine(
      id,
      recorded.model,
      { delta: {}, finish_reason: 'stop' },
      { usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 } }
    ),
    'data: [DONE]',
  ];
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
      lines.forEach((line, index) => {
        timers.push(
          setTimeout(
            () => {
              try {
                controller.enqueue(encoder.encode(`${line}\n\n`));
                if (index === lines.length - 1) {
                  onFinished();
                  controller.close();
                }
              } catch {
                // stream already errored by abort
              }
            },
            50 + index * STREAM_STEP_MS
          )
        );
      });
    },
    cancel() {
      timers.forEach(clearTimeout);
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Headers arrive, content never does, abort ends it: hedge losers and discarded speculation. */
export function stalledResponse(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        'abort',
        () => {
          try {
            controller.error(signal.reason ?? new Error('aborted'));
          } catch {
            // already closed
          }
        },
        { once: true }
      );
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const RECORD_ATTEMPTS = 4;
const pendingRecordings = new Set<Promise<void>>();

/** Wait for every detached recorder (including its provider re-asks) to finish. */
export async function settleRecordings(): Promise<void> {
  while (pendingRecordings.size > 0) await Promise.all([...pendingRecordings]);
}

/** Parse an SSE completion; `complete` only when the model stopped on its own. */
function parseStreamedCompletion(text: string): {
  model: string;
  content: string;
  complete: boolean;
} {
  let model = '';
  let content = '';
  let complete = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
    const event = JSON.parse(line.slice('data:'.length)) as {
      model?: string;
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
    };
    if (event.model) model = event.model;
    content += event.choices?.[0]?.delta?.content ?? '';
    // `length` is a token-cap cut-off (the router caps output at max_tokens), not a
    // complete response: recording it replays truncated JSON that can never parse.
    if (event.choices?.[0]?.finish_reason === 'stop') complete = true;
  }
  return { model, content, complete };
}

/**
 * Live passthrough that records the streamed content for the fixture. The caller
 * sees the first live response untouched; the recorder keeps only a completed
 * response and re-asks the provider (detached from the caller's abort signal)
 * when the first was cut off by the token cap or rejected, e.g. rate limited.
 */
export async function recordLiveCall(
  realFetch: typeof fetch,
  input: string | URL | Request,
  init: RequestInit | undefined,
  onRecorded: (recorded: { model: string; content: string }) => void
): Promise<Response> {
  const response = await realFetch(input, init);
  if (!response.body) return response;
  const [forCaller, forRecorder] = response.body.tee();
  const recording = (async () => {
    let firstText: string | undefined = response.ok
      ? await new Response(forRecorder).text()
      : undefined;
    const recorded = await retryWithBackoff(
      async () => {
        let text = firstText;
        firstText = undefined;
        if (text === undefined) {
          const retry = await realFetch(input, { ...init, signal: undefined });
          text = retry.ok ? await retry.text() : '';
        }
        const parsed = parseStreamedCompletion(text);
        if (!parsed.complete) throw new Error('recorded completion did not finish with stop');
        return parsed;
      },
      {
        maxRetries: RECORD_ATTEMPTS,
        fixedDelays: [2_000, 4_000, 6_000],
        isRetryable: () => true,
        component: 'ChatSearchEscalationRecorder',
      }
    );
    onRecorded({ model: recorded.model, content: recorded.content });
  })().catch(() => undefined);
  pendingRecordings.add(recording);
  void recording.finally(() => pendingRecordings.delete(recording));
  return new Response(forCaller, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
