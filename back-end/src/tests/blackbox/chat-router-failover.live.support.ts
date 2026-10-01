/**
 * Live-probe instrumentation for chat-router-failover: tees a real OpenRouter
 * stream so the probe can report which host served and how fast, without
 * changing what the Rose client reads.
 */

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
