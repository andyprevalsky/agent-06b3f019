/**
 * SSE line reader with an idle-timeout guard. Split out of streaming.ts
 * (max-lines cap); behavior unchanged.
 */

import { RoseStallError } from './errors';

/**
 * Read one chunk with an idle-timeout race. The timeout timer is cleared
 * as soon as the read wins so it can't later reject in the background as
 * an unhandled promise rejection.
 */
async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleTimeoutMs: number,
  requestId: string
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new RoseStallError(`SSE stream idle for >${idleTimeoutMs}ms (request_id=${requestId})`)
        ),
      idleTimeoutMs
    );
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Read SSE lines from a ReadableStream, raising RoseStallError if more
 * than `idleTimeoutMs` elapses between consecutive lines.
 */
export async function* iterLinesWithIdleTimeout(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
  requestId: string
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const result = await readWithIdleTimeout(reader, idleTimeoutMs, requestId);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        yield line;
      }
    }
    // Truncated streams may close mid-line; yield the remainder so callers
    // don't silently drop diagnostic data on an early provider disconnect.
    if (buffer.length > 0) {
      yield buffer;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
