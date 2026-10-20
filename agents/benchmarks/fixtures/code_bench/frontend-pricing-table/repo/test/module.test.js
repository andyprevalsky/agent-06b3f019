import assert from "node:assert/strict";
import { test } from "node:test";

import { PLANS } from "../src/plans.js";
import * as pricingTable from "../src/pricingTable.js";

test("module exports renderPricingTable", () => {
  assert.equal(typeof pricingTable.renderPricingTable, "function");
});

test("plans fixture has three plans", () => {
  assert.equal(PLANS.length, 3);
});
