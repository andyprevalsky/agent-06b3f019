/** Consume an R2 response body and tear it down if the enclosing deadline aborts. */
export async function streamToBuffer(body: unknown, signal?: AbortSignal): Promise<Buffer> {
  const destroyBody = (): void => {
    const destroy = (body as { destroy?: () => void } | null)?.destroy;
    if (typeof destroy === 'function') destroy.call(body);
  };
  if (signal?.aborted) {
    destroyBody();
    throw new Error('Archive response body aborted');
  }
  const readBody = async (): Promise<Buffer> => {
    if (body === undefined || body === null) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    const maybeTransform = body as {
      transformToByteArray?: () => Promise<Uint8Array>;
      transformToString?: () => Promise<string>;
    };
    if (typeof maybeTransform.transformToByteArray === 'function') {
      return Buffer.from(await maybeTransform.transformToByteArray());
    }
    if (typeof maybeTransform.transformToString === 'function') {
      return Buffer.from(await maybeTransform.transformToString());
    }
    const maybeAsyncIterable = body as AsyncIterable<Uint8Array>;
    if (typeof maybeAsyncIterable[Symbol.asyncIterator] === 'function') {
      const chunks: Buffer[] = [];
      for await (const chunk of maybeAsyncIterable) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    }
    throw new Error('Unsupported archive response body');
  };
  if (signal === undefined) return readBody();
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      destroyBody();
      reject(new Error('Archive response body aborted'));
    };
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([readBody(), aborted]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}
