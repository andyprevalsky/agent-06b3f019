import assert from "node:assert/strict";
import { test } from "node:test";

import { paginate } from "../src/paginate.js";

const items = Array.from({ length: 25 }, (_, i) => i + 1);

test("page 1 starts at the first item", () => {
  const result = paginate(items, 1);
  assert.deepEqual(result.items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(result.page, 1);
});

test("counts the final partial page", () => {
  assert.equal(paginate(items, 1).totalPages, 3);
  assert.deepEqual(paginate(items, 3).items, [21, 22, 23, 24, 25]);
  assert.equal(paginate(items.slice(0, 20), 1).totalPages, 2);
});

test("hasNext", () => {
  assert.equal(paginate(items, 2).hasNext, true);
  assert.equal(paginate(items, 3).hasNext, false);
});

test("custom page size", () => {
  assert.deepEqual(paginate(items, 2, 7).items, [8, 9, 10, 11, 12, 13, 14]);
  assert.equal(paginate(items, 1, 7).totalPages, 4);
});

test("empty list has one empty page", () => {
  assert.deepEqual(paginate([], 1), { items: [], page: 1, totalPages: 1, hasNext: false });
});

test("out of range pages throw RangeError", () => {
  assert.throws(() => paginate(items, 0), RangeError);
  assert.throws(() => paginate(items, 4), RangeError);
  assert.throws(() => paginate([], 2), RangeError);
});

test("invalid perPage throws RangeError", () => {
  assert.throws(() => paginate(items, 1, 0), RangeError);
  assert.throws(() => paginate(items, 1, 2.5), RangeError);
});

test("does not mutate input", () => {
  const copy = [...items];
  paginate(copy, 2);
  assert.deepEqual(copy, items);
});
