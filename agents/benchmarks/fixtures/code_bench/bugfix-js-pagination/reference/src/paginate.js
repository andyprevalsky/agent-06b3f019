/**
 * Return one page of `items`.
 *
 * Pages are 1-indexed: page 1 holds items[0 .. perPage-1]. `totalPages` counts
 * a final partial page, and an empty list still has one (empty) page.
 * `hasNext` is true when a later page exists. A page below 1 or above
 * `totalPages`, or a perPage that is not a positive integer, throws a
 * RangeError.
 *
 * @template T
 * @param {T[]} items
 * @param {number} page
 * @param {number} [perPage=10]
 * @returns {{items: T[], page: number, totalPages: number, hasNext: boolean}}
 */
export function paginate(items, page, perPage = 10) {
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new RangeError(`perPage must be a positive integer, got ${perPage}`);
  }
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (!Number.isInteger(page) || page < 1 || page > totalPages) {
    throw new RangeError(`page ${page} is outside 1..${totalPages}`);
  }
  const start = (page - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    page,
    totalPages,
    hasNext: page < totalPages,
  };
}
