/**
 * Eligibility rules for the one-time orphan-sandbox reaper
 * (scripts/reap-orphan-sandboxes.ts). Pure: no E2B, no database.
 *
 *   listed sandbox + prod references ──► decision { bucket, eligible }
 *
 * A sandbox is ELIGIBLE only when it is paused, referenced by no production row
 * (sandbox id, or metadata codeSessionId / ownerAgentId / rootAgentId), not
 * Render-origin, carries no `purpose` tag, and is either untagged and older
 * than 24 h or `host:`-origin tagged and older than 72 h. `startedAt` resets on
 * resume, so age is a rough proxy. Everything else is kept. The reference read
 * itself is sanity-checked first (`assessProdReferences`): empty/tiny sets or a
 * local database host mean the "unreferenced" verdicts cannot be trusted.
 */

export const UNTAGGED_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const HOST_TAGGED_MIN_AGE_MS = 72 * 60 * 60 * 1000;

export interface OrphanCandidate {
  sandboxId: string;
  state: string;
  startedAt: Date;
  templateId?: string;
  metadata: Record<string, string>;
}

export interface ProdReferences {
  sandboxIds: ReadonlySet<string>;
  codeSessionIds: ReadonlySet<string>;
  agentIds: ReadonlySet<string>;
}

export type OrphanBucket =
  | 'untagged-over-24h'
  | 'host-tagged-over-72h'
  | 'kept-running'
  | 'kept-by-reference'
  | 'kept-render'
  | 'kept-purpose'
  | 'kept-too-young'
  | 'kept-other-origin';

export interface OrphanDecision {
  bucket: OrphanBucket;
  eligible: boolean;
  reason: string;
}

export interface OrphanCriteria {
  untaggedMinAgeMs: number;
  hostTaggedMinAgeMs: number;
}

export const DEFAULT_ORPHAN_CRITERIA: OrphanCriteria = {
  untaggedMinAgeMs: UNTAGGED_MIN_AGE_MS,
  hostTaggedMinAgeMs: HOST_TAGGED_MIN_AGE_MS,
};

function keep(bucket: OrphanBucket, reason: string): OrphanDecision {
  return { bucket, eligible: false, reason };
}

export function referencedByProd(sandbox: OrphanCandidate, refs: ProdReferences): string | null {
  if (refs.sandboxIds.has(sandbox.sandboxId)) return 'sandbox id is recorded in a prod row';
  const { codeSessionId, ownerAgentId, rootAgentId } = sandbox.metadata;
  if (codeSessionId && refs.codeSessionIds.has(codeSessionId)) {
    return 'metadata codeSessionId matches a prod code session';
  }
  if (ownerAgentId && refs.agentIds.has(ownerAgentId)) {
    return 'metadata ownerAgentId matches a prod row';
  }
  if (rootAgentId && refs.agentIds.has(rootAgentId)) {
    return 'metadata rootAgentId matches a prod row';
  }
  return null;
}

export function decideOrphan(
  sandbox: OrphanCandidate,
  refs: ProdReferences,
  now: Date,
  criteria: OrphanCriteria = DEFAULT_ORPHAN_CRITERIA
): OrphanDecision {
  if (sandbox.state !== 'paused') return keep('kept-running', `state=${sandbox.state}`);
  const referenced = referencedByProd(sandbox, refs);
  if (referenced !== null) return keep('kept-by-reference', referenced);
  const { roseOrigin, roseStack, purpose } = sandbox.metadata;
  if (roseOrigin?.startsWith('render:')) return keep('kept-render', 'render-origin sandbox');
  if (purpose) return keep('kept-purpose', `purpose=${purpose}`);
  const age = now.getTime() - sandbox.startedAt.getTime();
  if (!roseOrigin && !roseStack) {
    return age > criteria.untaggedMinAgeMs
      ? { bucket: 'untagged-over-24h', eligible: true, reason: 'untagged, unreferenced, old' }
      : keep('kept-too-young', 'untagged but started within the age floor');
  }
  if (roseOrigin?.startsWith('host:')) {
    return age > criteria.hostTaggedMinAgeMs
      ? { bucket: 'host-tagged-over-72h', eligible: true, reason: 'host-tagged, unreferenced, old' }
      : keep('kept-too-young', 'host-tagged but started within the age floor');
  }
  return keep('kept-other-origin', `origin=${roseOrigin ?? 'none'}`);
}

/** Fewest distinct rows each reference set must hold before a production read is believable. */
export const MIN_PLAUSIBLE_PROD_REFS = 10;

export interface ProdReferenceAssessment {
  /** Database host only; credentials, port and path are never retained. */
  host: string;
  ok: boolean;
  problems: string[];
}

const DATABASE_HOST_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#]*@)?(\[[^\]]+\]|[^/:?#]+)/i;

/** Host of a database URL, lower-cased, without credentials; null when it cannot be read. */
export function databaseHostOf(databaseUrl: string | undefined): string | null {
  const match = databaseUrl === undefined ? null : DATABASE_HOST_PATTERN.exec(databaseUrl.trim());
  const host = match?.[1]?.replace(/^\[|\]$/g, '').toLowerCase();
  return host === undefined || host === '' ? null : host;
}

/**
 * True for hosts that cannot be the production database: loopback, wildcard,
 * private ranges, `.local` names and dotless docker/compose service names.
 */
export function isNonProductionHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
  if (host === 'host.docker.internal') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (octets !== null) {
    const [first, second] = [Number(octets[1]), Number(octets[2])];
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  return !host.includes('.') && !host.includes(':');
}

/**
 * Sanity check on the production reference read: an empty or tiny set (or one
 * read from a local/devbox database) would make every untagged paused sandbox
 * look orphaned. Pure; the reaper prints `host` so the operator can confirm.
 */
export function assessProdReferences(
  refs: ProdReferences,
  databaseUrl: string | undefined,
  minPerSet: number = MIN_PLAUSIBLE_PROD_REFS
): ProdReferenceAssessment {
  const problems: string[] = [];
  const host = databaseHostOf(databaseUrl);
  if (host === null) problems.push('cannot determine the database host from DIRECT_URL');
  else if (isNonProductionHost(host)) {
    problems.push(`DIRECT_URL host ${host} is a local/non-production database`);
  }
  const floor = Number.isFinite(minPerSet) ? Math.max(1, minPerSet) : MIN_PLAUSIBLE_PROD_REFS;
  const sets: Array<[string, ReadonlySet<string>]> = [
    ['sandboxIds', refs.sandboxIds],
    ['codeSessionIds', refs.codeSessionIds],
    ['agentIds', refs.agentIds],
  ];
  for (const [name, set] of sets) {
    if (set.size === 0) problems.push(`${name} is empty`);
    else if (set.size < floor) problems.push(`${name} has ${set.size} rows (< ${floor})`);
  }
  return { host: host ?? 'unknown', ok: problems.length === 0, problems };
}

/**
 * Execute refuses an implausible reference read; a dry run returns the loud
 * warning text (null when the references look fine) so the operator sees that
 * its eligible list cannot be trusted.
 */
export function enforceProdReferenceGuard(
  assessment: ProdReferenceAssessment,
  execute: boolean
): string | null {
  if (assessment.ok) return null;
  const detail = assessment.problems.join('; ');
  if (execute) throw new Error(`refusing --execute: production references look wrong: ${detail}`);
  return `WARNING: production references look wrong (${detail}); this dry-run eligible list is NOT trustworthy and --execute will refuse`;
}
