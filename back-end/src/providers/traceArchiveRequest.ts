const DEFAULT_R2_REQUEST_TIMEOUT_MS = 30_000;

function requestTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.TRACE_ARCHIVE_R2_REQUEST_TIMEOUT_MS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_R2_REQUEST_TIMEOUT_MS;
}

/** Give every R2 SDK operation a deadline so archive jobs cannot hang forever. */
export async function withTraceArchiveRequestTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = requestTimeoutMs();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`R2 trace archive request timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
