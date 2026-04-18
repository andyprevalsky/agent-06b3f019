/**
 * Canonical URL / query-param helpers.
 * Domain code must import from here instead of constructing
 * `new URLSearchParams(window.location.search)` ad-hoc —
 * enforced via `no-restricted-syntax`.
 */

export function getQueryParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}
