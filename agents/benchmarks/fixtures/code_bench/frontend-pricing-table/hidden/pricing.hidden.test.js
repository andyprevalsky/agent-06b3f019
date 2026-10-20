import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PLANS } from "../src/plans.js";
import { renderPricingTable } from "../src/pricingTable.js";

function articles(html) {
  return [...html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
}

function classOf(attrs) {
  const match = attrs.match(/\bclass\s*=\s*"([^"]*)"/);
  return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

function text(fragment) {
  return fragment.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

test("wraps the cards in section.pricing", () => {
  const html = renderPricingTable(PLANS);
  assert.equal(typeof html, "string");
  const section = html.match(/<section\b([^>]*)>/);
  assert.ok(section, "missing <section>");
  assert.ok(classOf(section[1]).includes("pricing"), "section needs class pricing");
});

test("renders one article.plan per plan, in order, with data-plan ids", () => {
  const cards = articles(renderPricingTable(PLANS));
  assert.equal(cards.length, 3);
  cards.forEach((card, i) => {
    assert.ok(classOf(card.attrs).includes("plan"));
    assert.match(card.attrs, new RegExp(`data-plan\\s*=\\s*"${PLANS[i].id}"`));
    const h3 = card.body.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/);
    assert.ok(h3, "each card needs an <h3>");
    assert.equal(text(h3[1]), PLANS[i].name);
  });
});

test("formats prices", () => {
  const plans = [
    { id: "a", name: "A", priceCents: 0, features: [] },
    { id: "b", name: "B", priceCents: 1200, features: [] },
    { id: "c", name: "C", priceCents: 4950, features: [] },
    { id: "d", name: "D", priceCents: 905, features: [] },
  ];
  const prices = articles(renderPricingTable(plans)).map((card) => {
    const p = card.body.match(/<p\b([^>]*)>([\s\S]*?)<\/p>/);
    assert.ok(p && classOf(p[1]).includes("price"), "each card needs p.price");
    return text(p[2]);
  });
  assert.deepEqual(prices, ["Free", "$12/mo", "$49.50/mo", "$9.05/mo"]);
});

test("lists features", () => {
  const cards = articles(renderPricingTable(PLANS));
  cards.forEach((card, i) => {
    const ul = card.body.match(/<ul\b[^>]*>([\s\S]*?)<\/ul>/);
    assert.ok(ul, "each card needs a <ul>");
    const items = [...ul[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
    assert.deepEqual(items, PLANS[i].features.map((f) => f.replace(/&/g, "&amp;")));
  });
});

test("highlights exactly the requested plan", () => {
  const cards = articles(renderPricingTable(PLANS, { highlight: "team" }));
  const featured = cards.filter((card) => classOf(card.attrs).includes("featured"));
  assert.equal(featured.length, 1);
  assert.match(featured[0].attrs, /data-plan\s*=\s*"team"/);
  assert.match(featured[0].body, /<span\b[^>]*class\s*=\s*"[^"]*\bbadge\b[^"]*"[^>]*>\s*Most popular\s*<\/span>/);
  const html = renderPricingTable(PLANS, { highlight: "team" });
  assert.equal((html.match(/Most popular/g) || []).length, 1);
});

test("no highlight means no featured card or badge", () => {
  const html = renderPricingTable(PLANS);
  assert.ok(!/featured/.test(html));
  assert.ok(!/Most popular/.test(html));
});

test("escapes text", () => {
  const html = renderPricingTable([
    { id: "x", name: "<script>alert(1)</script>", priceCents: 100, features: ["A & B", '"quoted"'] },
  ]);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("A &amp; B"));
});

test("does not mutate its input", () => {
  const plans = structuredClone(PLANS);
  renderPricingTable(plans, { highlight: "team" });
  assert.deepEqual(plans, PLANS);
});

test("styles lay the cards out in a row and emphasise the featured card", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const pricingRule = css.match(/\.pricing\s*\{([^}]*)\}/);
  assert.ok(pricingRule, "styles.css needs a .pricing rule");
  assert.match(pricingRule[1], /display\s*:\s*(flex|grid)/);
  assert.match(css, /\.featured\b[^{]*\{[^}]*\S[^}]*\}/, "styles.css needs a non-empty .featured rule");
});
