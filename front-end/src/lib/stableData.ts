/**
 * Keep the previous value's identity when a refreshed JSON payload carries the
 * same data, so an unchanged poll leaves React state untouched (no commit).
 *
 * poll result --same JSON as previous--> previous reference (React bails out)
 *             --any difference---------> next reference (normal update)
 *
 * Values are API JSON (plain objects, arrays, strings, numbers, booleans and
 * null), so serialization is an exact structural comparison for them.
 */
export function keepIfUnchanged<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/**
 * Element-wise version for lists: unchanged rows keep their previous object
 * (memoized rows skip rendering) and a fully unchanged list keeps its array.
 */
export function keepUnchangedItems<T>(
  previous: readonly T[],
  next: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const byKey = new Map(previous.map((item) => [keyOf(item), item]));
  let changed = previous.length !== next.length;
  const merged = next.map((item, index) => {
    const prior = byKey.get(keyOf(item));
    const kept = prior === undefined ? item : keepIfUnchanged(prior, item);
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? merged : (previous as T[]);
}
