/** Fresh write-domain claims: legacy bytes remain read-only archive evidence. */
export type ObjectPointer = { key: string; etag: string };
export type AgentIndexPointer = { index: ObjectPointer; revision: ObjectPointer };
export type Claim = {
  state: 'pending' | 'published' | 'hidden';
  publication: string;
  body_etag?: string;
  body_key?: string;
  visibility_key?: string;
  visibility_etag?: string;
};
export type OverlayCatalog = {
  format: 'benchmark-hub-overlay-v1';
  epoch: string;
  revision: number;
  runs: Array<Record<string, unknown>>;
  claims: Record<string, Claim>;
  agent_index?: AgentIndexPointer;
};
function validPointer(value: ObjectPointer | undefined): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    /^publications\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\.json$/.test(value.key) &&
    typeof value.etag === 'string' &&
    value.etag
  );
}
/** structuredClone does not preserve a dictionary's null prototype. */
export function cloneOverlay(value: OverlayCatalog): OverlayCatalog {
  const copy = structuredClone(value);
  copy.claims = Object.assign(Object.create(null), copy.claims);
  return copy;
}
export function parseOverlay(raw: string | null, epoch: string): OverlayCatalog {
  if (raw === null)
    return {
      format: 'benchmark-hub-overlay-v1',
      epoch,
      revision: 0,
      runs: [],
      claims: Object.create(null),
    };
  const v = JSON.parse(raw) as OverlayCatalog;
  if (
    v.format !== 'benchmark-hub-overlay-v1' ||
    v.epoch !== epoch ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    !Array.isArray(v.runs) ||
    !v.claims ||
    typeof v.claims !== 'object' ||
    Array.isArray(v.claims)
  )
    throw new Error('Invalid Hub overlay catalog');
  for (const [id, claim] of Object.entries(v.claims)) {
    if (
      !/^[A-Za-z0-9._-]+$/.test(id) ||
      !claim ||
      !['pending', 'published', 'hidden'].includes(claim.state) ||
      typeof claim.publication !== 'string' ||
      !claim.publication ||
      (claim.state === 'published' && (typeof claim.body_etag !== 'string' || !claim.body_etag))
    )
      throw new Error('Invalid Hub overlay claim');
    if (
      claim.body_key !== undefined ||
      claim.visibility_key !== undefined ||
      claim.visibility_etag !== undefined
    ) {
      if (
        claim.state !== 'published' ||
        !validPointer({ key: claim.body_key!, etag: claim.body_etag! }) ||
        !validPointer({ key: claim.visibility_key!, etag: claim.visibility_etag! }) ||
        !claim.body_key?.startsWith(`publications/${claim.publication}/body-`) ||
        !claim.visibility_key?.startsWith(`publications/${claim.publication}/visibility-`)
      )
        throw new Error('Invalid Hub committed publication pointers');
    }
  }
  if (
    Object.hasOwn(v, 'agent_index') &&
    (!v.agent_index ||
      typeof v.agent_index !== 'object' ||
      Array.isArray(v.agent_index) ||
      Object.keys(v.agent_index).length !== 2 ||
      !validPointer(v.agent_index.index) ||
      !validPointer(v.agent_index.revision) ||
      !v.agent_index.index.key.endsWith('/index.json') ||
      v.agent_index.revision.key !==
        v.agent_index.index.key.replace(/\/index\.json$/, '/revision.json'))
  )
    throw new Error('Invalid Hub committed agent index pointers');
  v.claims = Object.assign(Object.create(null), v.claims);
  const ids = new Set<string>();
  for (const row of v.runs) {
    if (
      !row ||
      typeof row.run_id !== 'string' ||
      ids.has(row.run_id) ||
      v.claims[row.run_id]?.state !== 'published'
    )
      throw new Error('Invalid Hub overlay row');
    ids.add(row.run_id);
  }
  for (const [id, claim] of Object.entries(v.claims))
    if (claim.state === 'published' && !ids.has(id))
      throw new Error('Hub published claim has no row');
  return v;
}
export function mergeCatalog(
  legacy: Array<Record<string, unknown>>,
  overlay: OverlayCatalog
): Array<Record<string, unknown>> {
  return [
    ...overlay.runs,
    ...legacy.filter(
      (row) => typeof row.run_id === 'string' && !Object.hasOwn(overlay.claims, row.run_id)
    ),
  ].sort((a, b) => (String(a.timestamp) < String(b.timestamp) ? 1 : -1));
}
