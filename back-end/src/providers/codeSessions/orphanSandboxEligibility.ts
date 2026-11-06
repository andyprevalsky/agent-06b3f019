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
 * resume, so age is a rough proxy. Everything else is kept.
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
