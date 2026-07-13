/**
 * Schedule an optional cache write without extending the user-visible chat
 * lifecycle. Both asynchronous rejection and synchronous writer failure are
 * observed by the supplied error callback.
 */
export function runCacheWriteInBackground(
  write: () => Promise<void>,
  onStored: () => void,
  onError: (error: unknown) => void
): void {
  try {
    void write().then(onStored).catch(onError);
  } catch (error) {
    onError(error);
  }
}
