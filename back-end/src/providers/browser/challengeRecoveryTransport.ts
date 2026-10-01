/** A fresh candidate can prove a previous browser's proxy tunnel is usable again. */
import type { NetworkSummaryEntry } from './challengeClassifierNetwork';

export interface TunnelCandidateEvidence {
  recoveryReason?: string | null;
  classifierReason: string;
  targetUrl: string;
  blockedResourceUrl?: string;
  pageUrl: string;
  documentUrl: string;
  documentStatus: number | null;
  documentMethod: string;
  cleanedDom: string | null;
  networkEntries: NetworkSummaryEntry[];
  failedRequestUrls: string[];
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The old browser's CONNECT error is historical once this candidate fetched the
 * same origin through its own proxy. A candidate with a current failure on the
 * page origin or the blocked resource origin, or a visible challenge, still fails.
 * The real checkout POST is never replayed
 * by recovery; the browser agent must make it after promotion.
 */
export function restoredTunnelCandidate(evidence: TunnelCandidateEvidence): boolean {
  if (!/\bERR_TUNNEL_CONNECTION_FAILED\b/i.test(evidence.recoveryReason || '')) return false;
  if (!/\btunnel\b|\bERR_TUNNEL_CONNECTION_FAILED\b/i.test(evidence.classifierReason)) {
    return false;
  }
  if (
    /captcha|cloudflare|human.verification|access.denied|checking your browser|interstitial|\b403\b|\b429\b|blank page|empty shell|missing.{0,30}(ui|content|product|checkout)|not loaded|unusable|not interactive/i.test(
      evidence.classifierReason
    )
  ) {
    return false;
  }
  const targetOrigin = originOf(evidence.targetUrl);
  const blockedOrigin = originOf(evidence.blockedResourceUrl || '');
  if (
    !targetOrigin ||
    originOf(evidence.pageUrl) !== targetOrigin ||
    originOf(evidence.documentUrl) !== targetOrigin ||
    evidence.documentStatus !== 200 ||
    evidence.documentMethod.toUpperCase() !== 'GET' ||
    (evidence.cleanedDom || '').trim().length < 100
  ) {
    return false;
  }
  const isCriticalOrigin = (url: string): boolean => {
    const origin = originOf(url);
    return origin === targetOrigin || (blockedOrigin !== null && origin === blockedOrigin);
  };
  if (
    evidence.failedRequestUrls.some(isCriticalOrigin) ||
    evidence.networkEntries.some(
      (entry) =>
        isCriticalOrigin(String(entry.url || entry.name || '')) &&
        (Number(entry.status) === 403 ||
          Number(entry.status) === 429 ||
          Number(entry.status) >= 500 ||
          /ERR_TUNNEL_CONNECTION_FAILED/i.test(String(entry.statusText || entry.status_text || '')))
    )
  ) {
    return false;
  }
  return true;
}
