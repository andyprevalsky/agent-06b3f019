/**
 * Pure error helpers shared across main-process domains and renderer features.
 */

export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? fallback;
  } catch {
    return fallback;
  }
}

export function getErrorMessageOrFallback(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) return error.message;
  return fallback;
}

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(getErrorMessage(error));
}
