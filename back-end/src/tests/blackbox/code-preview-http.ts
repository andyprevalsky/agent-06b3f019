/** Test-only HTTP client: preserve request/response semantics and capture transport failures. */
export function createCodePreviewHttp(baseUrl: string, apiKey: string) {
  return async function http(method: string, path: string, userId: string, body?: unknown) {
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
          'X-User-Id': userId,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      const failure = error as Error & {
        cause?: {
          name?: string;
          message?: string;
          code?: string;
          socket?: {
            localPort?: number;
            remotePort?: number;
            bytesRead?: number;
            bytesWritten?: number;
          };
        };
      };
      console.error(
        'CODE_PREVIEW_HTTP_FAILURE ' +
          JSON.stringify({
            method,
            path,
            durationMs: performance.now() - startedAt,
            name: failure.name,
            message: failure.message,
            causeName: failure.cause?.name,
            causeMessage: failure.cause?.message,
            causeCode: failure.cause?.code,
            socket: failure.cause?.socket && {
              localPort: failure.cause.socket.localPort,
              remotePort: failure.cause.socket.remotePort,
              bytesRead: failure.cause.socket.bytesRead,
              bytesWritten: failure.cause.socket.bytesWritten,
            },
          })
      );
      throw error;
    }
    const text = await response.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { raw: text };
    }
    return { status: response.status, data };
  };
}
