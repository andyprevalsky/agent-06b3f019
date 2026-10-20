import assert from "node:assert/strict";
import { test } from "node:test";

import { paginate } from "../src/paginate.js";

test("returns the requested page number", () => {
  assert.equal(paginate([1, 2, 3], 1, 2).page, 1);
});
