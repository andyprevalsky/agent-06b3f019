/** Benchmark Hub object I/O, with Render R2 and isolated local storage. */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as fs from 'node:fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { BenchmarkHubUnavailableError } from './benchmarkHubErrors';
import { isolatedObjectKey, isolatedR2Prefix } from './benchmarkHubIsolatedScope';
import {
  parseOverlay,
  mergeCatalog,
  cloneOverlay,
  type OverlayCatalog,
  type ObjectPointer,
} from './benchmarkHubOverlay';
import {
  beginPrivatePublications,
  stagePublicationWrite,
  commitPrivatePublications,
} from './benchmarkHubPublicationCommit';
import {
  assertHubStorageOwnership,
  hubStorageVersions,
  ownedHubStorageRequest,
} from './benchmarkHubStorageOwnership';

const LEGACY_PREFIX = 'benchmark-hub';
const EPOCH = process.env.BENCHMARK_HUB_STORAGE_EPOCH || '';
if (EPOCH && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(EPOCH))
  throw new Error('Invalid Hub storage epoch');
const WRITES_ENABLED = process.env.BENCHMARK_HUB_V2_WRITES === 'true';
const KEY_PREFIX = EPOCH ? `benchmark-hub-v2/${EPOCH}` : LEGACY_PREFIX;
const pairReads = new WeakMap<
  Map<string, string | null>,
  Map<string, Promise<Array<{ raw: string | null; etag: string | null }>>>
>();
const committedPairs = new WeakMap<
  Map<string, string | null>,
  Promise<{ catalog: OverlayCatalog; pair: Array<{ raw: string | null; etag: string | null }> }>
>();
const backfillStamps = new WeakMap<Map<string, string | null>, string>();
const remoteCache = new Map<string, { raw: string; etag: string }>();
let parsedCatalog: { etag: string | null; value: OverlayCatalog } | undefined;
// The local-directory Hub serializes its index read-modify-write with a
// Postgres advisory lock, which is scoped to one database. Backends on
// different databases (parallel coverage shards, blackbox runs) must therefore
// use different directories: test runners set BENCHMARK_HUB_LOCAL_DIR per run.
const LOCAL_HUB_ROOT =
  process.env.BENCHMARK_HUB_LOCAL_DIR ||
  path.join(__dirname, '..', '..', '..', '.context', 'benchmark-hub');
const isolatedRunId =
  process.env.BENCHMARK_ISOLATED_RUN === 'true' ? process.env.BENCHMARK_RUN_ID : undefined;
if (
  process.env.BENCHMARK_ISOLATED_RUN === 'true' &&
  (isolatedRunId === '.' ||
    isolatedRunId === '..' ||
    !/^[A-Za-z0-9._-]+$/.test(isolatedRunId ?? ''))
) {
  throw new Error('BENCHMARK_RUN_ID must be a safe, nonempty ID for an isolated Benchmark Hub');
}
// Each isolated stack has its own database. Keep its local Hub index in the
// same isolation boundary so parallel stacks cannot overwrite one another's
// run registrations before the terminal bundles are mirrored to the durable Hub.
const LOCAL_DIR = isolatedRunId
  ? path.join(LOCAL_HUB_ROOT, 'isolated-runs', isolatedRunId)
  : LOCAL_HUB_ROOT;
let s3Client: S3Client | null = null;

async function writeIsolated(
  prefix: string,
  key: string,
  data: string,
  signal?: AbortSignal
): Promise<void> {
  const versions = hubStorageVersions();
  const physical = `${prefix}/${key}`;
  // Preserve the first observation; failed CAS never refreshes or retries.
  if (versions && !versions.has(physical)) await readRemoteObject(key, signal, prefix);
  const expected = versions
    ? versions.get(physical)
    : (await readRemoteObject(key, signal, prefix)).etag;
  if (expected === undefined) throw new Error('Benchmark Hub write has no object observation');
  assertHubStorageOwnership();
  const response = await getS3Client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
      Key: physical,
      Body: encodePublication(data),
      ContentType: 'application/json',
      ...(expected === null ? { IfNoneMatch: '*' } : { IfMatch: expected }),
    }),
    { abortSignal: signal }
  );
  assertHubStorageOwnership();
  if (!response.ETag) throw new Error('Benchmark Hub write returned no ETag');
  versions?.set(physical, response.ETag);
  remoteCache.delete(physical);
}

function r2Configured(): boolean {
  if (isolatedR2Prefix() !== null) return true;
  // Local workspaces have production R2 credentials available for trace
  // diagnostics, but Benchmark Hub writes must stay worktree-local. Otherwise
  // independent test databases race through one production index and local
  // cleanup can hide real runs. Use Render's deployment identity rather than
  // NODE_ENV: local production-mode builds must remain isolated too.
  const useR2 = process.env.BENCHMARK_HUB_STORAGE !== 'local' && process.env.RENDER === 'true';
  return Boolean(
    useR2 &&
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_TRACE_ARCHIVE
  );
}

function getS3Client(): S3Client {
  if (s3Client !== null) return s3Client;
  const accountId = process.env.R2_ACCOUNT_ID || '';
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
  return s3Client;
}

async function streamToBuffer(body: unknown, signal?: AbortSignal): Promise<Buffer> {
  assertHubStorageOwnership();
  if (body instanceof Buffer) return body;
  const stream = body as AsyncIterable<Uint8Array> & {
    destroy?: (error: Error) => void;
  };
  const abort = () => stream.destroy?.(new Error('Benchmark Hub body ownership ended'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) {
      abort();
      signal.throwIfAborted();
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      assertHubStorageOwnership();
      chunks.push(chunk);
    }
    assertHubStorageOwnership();
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

const PUBLICATION_FORMAT = 'rose-benchmark-hub-publication-v1';
function encodePublication(data: string): string {
  return JSON.stringify({
    format: PUBLICATION_FORMAT,
    publication: randomUUID(),
    payload: data,
  });
}
function decodePublication(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
  const value = parsed as Record<string, unknown>;
  if (value.format !== PUBLICATION_FORMAT) return raw;
  if (
    typeof value.publication !== 'string' ||
    !value.publication ||
    typeof value.payload !== 'string' ||
    Object.keys(value).length !== 3
  ) {
    throw new Error('Invalid Benchmark Hub publication envelope');
  }
  return value.payload;
}

async function writeRemote(key: string, data: string, signal?: AbortSignal): Promise<string> {
  if (!EPOCH || !WRITES_ENABLED)
    throw new BenchmarkHubUnavailableError(
      'Hub publication is paused pending storage epoch activation'
    );
  const versions = hubStorageVersions();
  const physical = `${KEY_PREFIX}/${key}`;
  if (versions && !versions.has(physical)) await readRemoteObject(key, signal);
  const expected = versions ? versions.get(physical) : (await readRemoteObject(key, signal)).etag;
  if (expected === undefined) throw new Error('Hub write has no physical object observation');
  assertHubStorageOwnership();

  const response = await getS3Client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
      Key: physical,
      Body: encodePublication(data),
      ContentType: 'application/json',
      ...(expected === null ? { IfNoneMatch: '*' } : { IfMatch: expected }),
    }),
    { abortSignal: signal }
  );
  assertHubStorageOwnership();
  if (!response.ETag) throw new Error('Hub write returned no ETag');
  versions?.set(physical, response.ETag);
  remoteCache.delete(physical);
  if (versions && key === 'index.json') committedPairs.delete(versions);
  if (versions && key.startsWith('agent-run-index')) pairReads.get(versions)?.delete(KEY_PREFIX);
  return response.ETag;
}
async function catalog(signal?: AbortSignal, mutable = false): Promise<OverlayCatalog> {
  const value = await readRemoteObject('index.json', signal);
  if (!parsedCatalog || parsedCatalog.etag !== value.etag)
    parsedCatalog = {
      etag: value.etag,
      value: parseOverlay(value.raw === null ? null : decodePublication(value.raw), EPOCH),
    };
  return mutable ? cloneOverlay(parsedCatalog.value) : parsedCatalog.value;
}
/** Called only after the owning store has validated every selected publication. */
export async function beginHubPublications(ids: string[]): Promise<void> {
  if (!r2Configured() || isolatedR2Prefix() !== null) return;
  if (!EPOCH || !WRITES_ENABLED)
    throw new BenchmarkHubUnavailableError(
      'Hub publication is paused pending storage epoch activation'
    );
  beginPrivatePublications(ids);
}
export async function putObject(key: string, data: string): Promise<void> {
  await ownedHubStorageRequest(async (signal) => {
    if (r2Configured()) {
      const isolated = isolatedObjectKey(key);
      if (isolated !== null) {
        await writeIsolated(isolated, key, data, signal);
        return;
      }
      if (!EPOCH || !WRITES_ENABLED)
        throw new BenchmarkHubUnavailableError(
          'Hub publication is paused pending storage epoch activation'
        );
      const io = { catalog, write: writeRemote };
      if (EPOCH && key === 'index.json') {
        const rows = JSON.parse(data) as Array<Record<string, unknown>>;
        if (!Array.isArray(rows)) throw new Error('Invalid Hub logical catalog');
        await commitPrivatePublications(rows, io, signal);
        return;
      }
      const versions = hubStorageVersions();
      if (key === 'agent-run-index.json')
        data = JSON.stringify({
          ...JSON.parse(data),
          _hub_legacy_observation: await hubLegacyArchiveStamp(),
          ...(versions && backfillStamps.has(versions)
            ? { _hub_legacy_backfill: backfillStamps.get(versions) }
            : {}),
        });
      if (await stagePublicationWrite(key, data, io, signal)) return;
      await writeRemote(key, data, signal);
      return;
    }
    const target = path.join(LOCAL_DIR, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    assertHubStorageOwnership();
    const tmp = `${target}.tmp-${process.pid}`;
    await fs.writeFile(tmp, data);
    assertHubStorageOwnership();
    await fs.rename(tmp, target);
  });
}

function isObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as {
    code?: unknown;
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    record.code === 'ENOENT' ||
    record.name === 'NoSuchKey' ||
    record.name === 'NotFound' ||
    record.$metadata?.httpStatusCode === 404
  );
}

async function readRemoteObject(
  key: string,
  signal?: AbortSignal,
  prefix = KEY_PREFIX
): Promise<{ raw: string | null; etag: string | null }> {
  const physical = `${prefix}/${key}`;
  const cacheable = [
    'index.json',
    'agent-run-index.json',
    'agent-run-index-revision.json',
  ].includes(key);
  const cached = cacheable ? remoteCache.get(physical) : undefined;
  try {
    assertHubStorageOwnership();
    const response = await getS3Client().send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
        Key: `${prefix}/${key}`,
        ...(cached ? { IfNoneMatch: cached.etag } : {}),
      }),
      { abortSignal: signal }
    );
    const raw = (await streamToBuffer(response.Body, signal)).toString('utf-8');
    assertHubStorageOwnership();
    if (!response.ETag) throw new Error('Benchmark Hub read returned no ETag');
    if (cacheable) remoteCache.set(physical, { raw, etag: response.ETag });
    const versions = hubStorageVersions();
    if (versions && !versions.has(physical)) versions.set(physical, response.ETag);
    return { raw, etag: response.ETag };
  } catch (error: unknown) {
    assertHubStorageOwnership();
    if (
      cached &&
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 304
    ) {
      const versions = hubStorageVersions();
      if (versions && !versions.has(physical)) versions.set(physical, cached.etag);
      return cached;
    }
    if (isObjectNotFound(error)) {
      remoteCache.delete(physical);
      const versions = hubStorageVersions();
      if (versions && !versions.has(physical)) versions.set(physical, null);
      return { raw: null, etag: null };
    }
    throw error;
  }
}

async function agentPair(
  prefix: string,
  signal?: AbortSignal
): Promise<Array<{ raw: string | null; etag: string | null }>> {
  const versions = hubStorageVersions();
  let pairs = versions ? pairReads.get(versions) : undefined;
  if (!pairs && versions) {
    pairs = new Map();
    pairReads.set(versions, pairs);
  }
  let pair = pairs?.get(prefix);
  if (!pair) {
    pair = Promise.all(
      ['agent-run-index.json', 'agent-run-index-revision.json'].map((key) =>
        readRemoteObject(key, signal, prefix)
      )
    );
    pairs?.set(prefix, pair);
  }
  return pair;
}

async function readPointer(
  pointer: ObjectPointer,
  signal?: AbortSignal
): Promise<{ raw: string; etag: string }> {
  const value = await readRemoteObject(pointer.key, signal);
  if (value.raw === null || value.etag !== pointer.etag)
    throw new Error('Hub committed index pointer differs from its publication');
  return { raw: value.raw, etag: value.etag };
}

/** Both logical compact-index keys project one captured committed catalog head. */
async function committedAgentPair(signal?: AbortSignal) {
  const versions = hubStorageVersions();
  let pending = versions ? committedPairs.get(versions) : undefined;
  if (!pending) {
    pending = (async () => {
      const value = await catalog(signal);
      const pair = value.agent_index
        ? await Promise.all(
            [value.agent_index.index, value.agent_index.revision].map((pointer) =>
              readPointer(pointer, signal)
            )
          )
        : await agentPair(KEY_PREFIX, signal);
      return { catalog: value, pair };
    })();
    if (versions) committedPairs.set(versions, pending);
  }
  return pending;
}

/** Null means confirmed missing; transport, ownership and codec faults throw. */
export async function getObjectStrict(key: string): Promise<string | null> {
  return ownedHubStorageRequest(async (signal) => {
    if (r2Configured()) {
      const isolated = isolatedObjectKey(key);
      if (isolated !== null) {
        const value = await readRemoteObject(key, signal, isolated);
        return value.raw === null ? null : decodePublication(value.raw);
      }
      if (!EPOCH) return (await readRemoteObject(key, signal)).raw;
      if (key === 'index.json') {
        const value = await catalog(signal);
        const old = (await readRemoteObject(key, signal, LEGACY_PREFIX)).raw;
        const legacy = old === null ? [] : JSON.parse(old);
        if (!Array.isArray(legacy)) throw new Error('Invalid legacy Hub catalog');
        return JSON.stringify(mergeCatalog(legacy, value));
      }
      const selected = /^(runs|visibility)\/([A-Za-z0-9._-]+)\.json$/.exec(key);
      if (selected) {
        const value = await catalog(signal);
        const id = selected[2];
        const claim = Object.hasOwn(value.claims, id) ? value.claims[id] : undefined;
        if (claim?.state === 'hidden') return selected[1] === 'visibility' ? 'false' : null;
        if (claim?.state === 'pending') throw new Error('Hub publication is pending');
        const own = await readRemoteObject(
          claim?.state === 'published'
            ? ((selected[1] === 'runs' ? claim.body_key : claim.visibility_key) ?? key)
            : key,
          signal
        );
        if (claim?.state === 'published') {
          const body =
            selected[1] === 'runs'
              ? own
              : await readRemoteObject(claim.body_key ?? `runs/${id}.json`, signal);
          if (body.raw === null || body.etag !== claim.body_etag)
            throw new Error('Hub body differs from committed publication');
          const marker =
            selected[1] === 'visibility'
              ? own
              : await readRemoteObject(claim.visibility_key ?? `visibility/${id}.json`, signal);
          if (
            marker.raw === null ||
            (claim.visibility_etag && marker.etag !== claim.visibility_etag) ||
            decodePublication(marker.raw) !== 'true'
          )
            throw new Error('Hub committed visibility is missing');
          return own.raw === null ? null : decodePublication(own.raw);
        }
        const peer = await readRemoteObject(
          `${selected[1] === 'runs' ? 'visibility' : 'runs'}/${id}.json`,
          signal
        );
        if (own.raw !== null || peer.raw !== null)
          throw new Error('Hub new-domain object has no committed claim');
        return (await readRemoteObject(key, signal, LEGACY_PREFIX)).raw;
      }
      const isAgentPair = key === 'agent-run-index.json' || key === 'agent-run-index-revision.json';
      const snapshot = isAgentPair ? await committedAgentPair(signal) : undefined;
      const committed = snapshot?.catalog;
      const pair = snapshot?.pair;
      const own = pair
        ? pair[key === 'agent-run-index.json' ? 0 : 1]
        : await readRemoteObject(key, signal);
      if (pair) {
        const other = pair[key === 'agent-run-index.json' ? 1 : 0];
        if ((own.raw === null) !== (other.raw === null))
          throw new Error('Hub new-domain agent index pair is incomplete');
        if (own.raw === null) {
          const legacyPair = await agentPair(LEGACY_PREFIX, signal);
          const legacy = legacyPair[key === 'agent-run-index.json' ? 0 : 1];
          if (key === 'agent-run-index.json' && legacy.raw !== null) {
            let document: { agents: Record<string, string> };
            try {
              document = JSON.parse(legacy.raw);
            } catch {
              return legacy.raw;
            }
            const value = await catalog(signal);
            return JSON.stringify({
              ...document,
              agents: Object.fromEntries(
                Object.entries(document.agents || {}).filter(
                  ([, id]) => !Object.hasOwn(value.claims, String(id))
                )
              ),
              _hub_cache_version: `${KEY_PREFIX}|missing|${legacy.etag}|${legacyPair[1].etag}|${committed?.revision ?? 'missing'}`,
            });
          }
          return legacy.raw;
        }
        if (key === 'agent-run-index.json') {
          const current = JSON.parse(decodePublication(own.raw));
          const legacyPair = await agentPair(LEGACY_PREFIX, signal);
          const old = legacyPair[0].raw;
          let legacyDocument: {
            agents?: Record<string, string>;
            revision?: number;
            complete?: boolean;
          } | null;
          try {
            legacyDocument = old === null ? null : JSON.parse(old);
          } catch {
            legacyDocument = null;
          }
          const floor = legacyPair[1];
          const revision = floor.raw === null ? 0 : JSON.parse(floor.raw).revision;
          const invalidLegacy =
            !Number.isSafeInteger(revision) ||
            revision < 0 ||
            (legacyDocument?.revision ?? 0) < revision;
          const stamp = await hubLegacyArchiveStamp();
          const backfilled = current._hub_legacy_backfill === stamp;
          const sameObservation = current._hub_legacy_observation === stamp;
          if (invalidLegacy && !backfilled && !sameObservation)
            throw new Error('Legacy Hub index trails its revision floor');
          const legacy = legacyDocument?.agents || {};
          const value = committed!;
          const legacyRows = JSON.parse(
            remoteCache.get(`${LEGACY_PREFIX}/index.json`)?.raw || '[]'
          ) as Array<{ run_id: string }>;
          const legacyIds = new Set(legacyRows.map((row) => row.run_id));
          const allowed = Object.fromEntries(
            Object.entries(legacy || {}).filter(
              ([, id]) => !Object.hasOwn(value.claims, String(id)) && legacyIds.has(String(id))
            )
          );
          return JSON.stringify({
            ...current,
            complete:
              current.complete === true && (legacyDocument?.complete === true || backfilled),
            agents: {
              ...allowed,
              ...Object.fromEntries(
                Object.entries(current.agents).filter(
                  ([, id]) =>
                    value.claims[String(id)]?.state === 'published' ||
                    ((sameObservation || backfilled) &&
                      !Object.hasOwn(value.claims, String(id)) &&
                      legacyIds.has(String(id)))
                )
              ),
            },
            _hub_cache_version: `${KEY_PREFIX}|${own.etag}|${other.etag}|${remoteCache.get(`${LEGACY_PREFIX}/${key}`)?.etag || 'missing'}|${floor.etag || 'missing'}|${committed?.revision ?? 'missing'}`,
          });
        }
      }
      return own.raw === null ? null : decodePublication(own.raw);
    }
    try {
      return decodePublication(await fs.readFile(path.join(LOCAL_DIR, key), 'utf-8'));
    } catch (error: unknown) {
      assertHubStorageOwnership();
      if (isObjectNotFound(error)) return null;
      throw error;
    }
  });
}

export async function getObject(key: string): Promise<string | null> {
  // Isolated reads distinguish confirmed absence from storage/scope failures.
  if (process.env.BENCHMARK_HUB_STORAGE === 'r2-isolated') return getObjectStrict(key);
  try {
    return await getObjectStrict(key);
  } catch (error) {
    assertHubStorageOwnership();
    if (EPOCH)
      throw error instanceof BenchmarkHubUnavailableError
        ? error
        : new BenchmarkHubUnavailableError('Hub storage is temporarily unavailable');
    return null;
  }
}

/** Test-only: clear the lazily configured object-store client. */
export function resetHubObjectStorageForTests(): void {
  s3Client = null;
  remoteCache.clear();
  parsedCatalog = undefined;
}

export function hubOverlayEnabled(): boolean {
  return Boolean(EPOCH && r2Configured() && isolatedR2Prefix() === null);
}
export function hubWritesEnabled(): boolean {
  return !r2Configured() || isolatedR2Prefix() !== null || Boolean(EPOCH && WRITES_ENABLED);
}

export function hubStorageDomain(): string {
  return isolatedR2Prefix() ?? (EPOCH ? KEY_PREFIX : LEGACY_PREFIX);
}

/** Compact provenance for a cold legacy scan; no new-domain ACK depends on it. */
export async function hubLegacyArchiveStamp(): Promise<string | undefined> {
  if (!hubOverlayEnabled()) return undefined;
  return ownedHubStorageRequest(async (signal) => {
    const keys = ['index.json', 'agent-run-index.json', 'agent-run-index-revision.json'];
    const first = await readRemoteObject(keys[0], signal, LEGACY_PREFIX);
    const values = [first, ...(await agentPair(LEGACY_PREFIX, signal))];
    return JSON.stringify(values.map((value) => value.etag));
  });
}
export async function bindHubLegacyBackfill(stamp?: string): Promise<void> {
  if (!hubOverlayEnabled()) return;
  if (!stamp || stamp !== (await hubLegacyArchiveStamp()))
    throw new BenchmarkHubUnavailableError('Legacy Hub archive changed during backfill');
  const versions = hubStorageVersions();
  if (!versions) throw new Error('Hub backfill requires SQL ownership');
  backfillStamps.set(versions, stamp);
}

/** Version helpers address the production domain; an isolated scope never reaches it. */
function refuseIsolatedObjectVersion(): void {
  if (isolatedR2Prefix() !== null)
    throw new Error('Hub object versions are unavailable in isolated R2');
}
/** Physical CAS boundary shared by logical publication and transport qualification. */
export async function putHubObjectVersion(key: string, data: string): Promise<void> {
  refuseIsolatedObjectVersion();
  return ownedHubStorageRequest(async (signal) => {
    await writeRemote(key, data, signal);
  });
}
export async function getHubObjectVersion(key: string): Promise<string | null> {
  refuseIsolatedObjectVersion();
  return ownedHubStorageRequest(async (signal) => {
    const value = await readRemoteObject(key, signal);
    return value.raw === null ? null : decodePublication(value.raw);
  });
}
