/**
 * Render the pricing table as an HTML string.
 *
 * @param {Array<{id: string, name: string, priceCents: number, features: string[]}>} plans
 * @param {{highlight?: string}} [options]
 * @returns {string}
 */
export function renderPricingTable(plans, options = {}) {
  const cards = plans.map((plan) => renderCard(plan, plan.id === options.highlight)).join("");
  return `<section class="pricing">${cards}</section>`;
}

function renderCard(plan, featured) {
  const classes = featured ? "plan featured" : "plan";
  const badge = featured ? '<span class="badge">Most popular</span>' : "";
  const features = plan.features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("");
  return (
    `<article class="${classes}" data-plan="${escapeHtml(plan.id)}">` +
    badge +
    `<h3>${escapeHtml(plan.name)}</h3>` +
    `<p class="price">${formatPrice(plan.priceCents)}</p>` +
    `<ul>${features}</ul>` +
    "</article>"
  );
}

function formatPrice(cents) {
  if (cents === 0) return "Free";
  const dollars = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  return `$${dollars}/mo`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
