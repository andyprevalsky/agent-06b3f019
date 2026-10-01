/**
 * In-memory site table. Sites live for one benchmark run, are only ever read by
 * the backend process that created them (the fixture API and the pages share a
 * process), and are bounded by count and age so a long-lived dev stack never
 * grows without limit.
 */

import { MAX_ACTIVE_SITES, SITE_TTL_MS } from './config';
import type { AuthTestSite } from './types';

const sites = new Map<string, AuthTestSite>();

function evictExpired(nowMs: number): void {
  for (const [siteId, site] of sites) {
    if (nowMs - site.createdAtMs > SITE_TTL_MS) sites.delete(siteId);
  }
}

export function putSite(site: AuthTestSite, nowMs = Date.now()): void {
  evictExpired(nowMs);
  while (sites.size >= MAX_ACTIVE_SITES) {
    const oldest = sites.keys().next();
    if (oldest.done === true) break;
    sites.delete(oldest.value);
  }
  sites.set(site.siteId, site);
}

export function getSite(siteId: string, nowMs = Date.now()): AuthTestSite | null {
  const site = sites.get(siteId);
  if (site === undefined) return null;
  if (nowMs - site.createdAtMs > SITE_TTL_MS) {
    sites.delete(siteId);
    return null;
  }
  return site;
}

export function deleteSite(siteId: string): boolean {
  return sites.delete(siteId);
}
