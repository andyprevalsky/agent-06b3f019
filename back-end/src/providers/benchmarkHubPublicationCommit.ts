/** Private immutable staging; the catalog CAS is the sole publication point. */
import { randomUUID } from 'node:crypto';
import { hubStorageVersions } from './benchmarkHubStorageOwnership';
import type { AgentIndexPointer, ObjectPointer, OverlayCatalog } from './benchmarkHubOverlay';

type StagedRun = { publication: string; body?: ObjectPointer; visibility?: ObjectPointer };
type Staging = {
  runs: Map<string, StagedRun>;
  hidden: Set<string>;
  indexId?: string;
  index?: ObjectPointer;
  revision?: ObjectPointer;
};
export type PublicationIO = {
  catalog: (signal?: AbortSignal, mutable?: boolean) => Promise<OverlayCatalog>;
  write: (key: string, data: string, signal?: AbortSignal) => Promise<string>;
};
const staging = new WeakMap<Map<string, string | null>, Staging>();
function owner(): { versions: Map<string, string | null>; value: Staging } {
  const versions = hubStorageVersions();
  if (!versions) throw new Error('Hub publication requires SQL ownership');
  let value = staging.get(versions);
  if (!value) {
    value = { runs: new Map(), hidden: new Set() };
    staging.set(versions, value);
  }
  return { versions, value };
}
export function beginPrivatePublications(ids: string[]): void {
  const { value } = owner();
  for (const id of new Set(ids)) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Invalid Hub publication ID');
    if (value.runs.has(id)) throw new Error('Hub publication was already staged');
    value.runs.set(id, { publication: randomUUID() });
  }
}
async function pointer(
  io: PublicationIO,
  key: string,
  data: string,
  signal?: AbortSignal
): Promise<ObjectPointer> {
  return { key, etag: await io.write(key, data, signal) };
}
/** Return false only for unrelated logical keys. No live object is overwritten. */
export async function stagePublicationWrite(
  key: string,
  data: string,
  io: PublicationIO,
  signal?: AbortSignal
): Promise<boolean> {
  const selected = /^(runs|visibility)\/([A-Za-z0-9._-]+)\.json$/.exec(key);
  if (selected) {
    const { value } = owner();
    const id = selected[2];
    if (selected[1] === 'visibility' && data === 'false') {
      value.hidden.add(id);
      return true;
    }
    const run = value.runs.get(id);
    if (!run) throw new Error('Hub run write has no private publication');
    const field = selected[1] === 'runs' ? 'body' : 'visibility';
    if (field === 'visibility' && data !== 'true')
      throw new Error('Invalid Hub publication visibility');
    run[field] = await pointer(
      io,
      `publications/${run.publication}/${field}-${randomUUID()}.json`,
      data,
      signal
    );
    return true;
  }
  if (key === 'agent-run-index.json' || key === 'agent-run-index-revision.json') {
    const { value } = owner();
    value.indexId ??= randomUUID();
    const field = key === 'agent-run-index.json' ? 'index' : 'revision';
    if (value[field]) throw new Error('Hub immutable agent index object was already staged');
    value[field] = await pointer(io, `publications/${value.indexId}/${field}.json`, data, signal);
    // Backfill-only repairs have no later catalog write in the Store facade.
    if (value.index && value.revision && !value.runs.size && !value.hidden.size)
      await commitPrivatePublications(undefined, io, signal);
    return true;
  }
  return false;
}
export async function commitPrivatePublications(
  rows: Array<Record<string, unknown>> | undefined,
  io: PublicationIO,
  signal?: AbortSignal
): Promise<void> {
  const { versions, value } = owner();
  const catalog = await io.catalog(signal, true);
  for (const [id, run] of value.runs) {
    if (!run.body || !run.visibility) throw new Error('Hub publication is incomplete');
    catalog.claims[id] = {
      state: 'published',
      publication: run.publication,
      body_key: run.body.key,
      body_etag: run.body.etag,
      visibility_key: run.visibility.key,
      visibility_etag: run.visibility.etag,
    };
  }
  for (const id of value.hidden)
    catalog.claims[id] = { state: 'hidden', publication: randomUUID() };
  if (value.index || value.revision) {
    if (!value.index || !value.revision)
      throw new Error('Hub staged agent index pair is incomplete');
    catalog.agent_index = {
      index: value.index,
      revision: value.revision,
    } satisfies AgentIndexPointer;
  } else if (value.runs.size) throw new Error('Hub publication has no staged agent index pair');
  catalog.runs = (rows ?? catalog.runs).filter(
    (row) =>
      Object.hasOwn(catalog.claims, String(row.run_id)) &&
      catalog.claims[String(row.run_id)].state === 'published'
  );
  catalog.revision++;
  await io.write('index.json', JSON.stringify(catalog), signal);
  staging.delete(versions);
}
