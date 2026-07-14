/**
 * Stream adapter that permits provider fall-through only before caller-visible
 * content. Once any content is emitted, errors propagate without model splicing.
 */

import { isFallThroughError, RoseError } from './errors';
import type { CompletionChunk, RoseStreamChunk } from './types';

export class PreContentFallThroughError extends Error {
  readonly cause: RoseError;

  constructor(cause: RoseError) {
    super(cause.message);
    this.name = 'PreContentFallThroughError';
    this.cause = cause;
  }
}

interface RunWithFallThroughOptions {
  produce: () => AsyncIterable<RoseStreamChunk>;
  emit: (chunk: RoseStreamChunk) => CompletionChunk | null;
}

export async function* runWithFallThrough(
  opts: RunWithFallThroughOptions
): AsyncIterable<CompletionChunk> {
  let yieldedAny = false;
  const iterator = opts.produce()[Symbol.asyncIterator]();

  try {
    while (true) {
      let result: IteratorResult<RoseStreamChunk>;
      try {
        result = await iterator.next();
      } catch (error) {
        if (!yieldedAny && error instanceof RoseError && isFallThroughError(error)) {
          throw new PreContentFallThroughError(error);
        }
        throw error;
      }
      if (result.done) return;
      const output = opts.emit(result.value);
      if (output) {
        yield output;
        yieldedAny = true;
      }
    }
  } finally {
    if (iterator.return) {
      try {
        await iterator.return();
      } catch {
        // The upstream cleanup path has no useful recovery action here.
      }
    }
  }
}
