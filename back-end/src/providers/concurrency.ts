/**
 * Map over values with at most `concurrency` tasks in flight, keeping input order.
 */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await task(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, worker)
  );
  return results;
}
